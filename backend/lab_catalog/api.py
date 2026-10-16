"""FastAPI boundary: authentication, exact authority checks and bounded bodies."""
import hashlib
import hmac
import os
from pathlib import Path
import secrets
import sqlite3
import json
import tempfile
import time
from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, Depends, FastAPI, File as UploadField, Form, Query, Request, Response, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.security import APIKeyCookie, HTTPBearer
from pydantic import ValidationError
from starlette.exceptions import HTTPException

from . import schemas as s
from .database import reject_symlinks
from .files import BODY_LIMIT, JSON_LIMIT, DECODE_ERRORS, member_bytes, text_content
from .service import Catalog, CatalogError, page, invalid, missing

COOKIE = 'lab_catalog_session'
SESSION_SECONDS = 8 * 60 * 60
Limit = Annotated[int, Query(ge=1, le=200)]
Offset = Annotated[int, Query(ge=0)]
DeleteRevision = Annotated[int | None, Query(ge=1, description='Optional displayed revision for concurrency-safe lab, exercise, team, material, evidence or assessment deletion; omission retains the legacy unguarded contract.')]
DELETE_CONFIRMATION_DESCRIPTION = (' With cascade=true, confirmation_token is required from the scoped GET deletion-impact. '
    'The SHA-256 fingerprint covers full deduplicated plan IDs, JSON resource state, associations, attachments and history, not just the 50-file preview. '
    'Ownership and optional displayed revision are checked before token comparison inside BEGIN IMMEDIATE. '
    'A changed plan returns 409 deletion_changed without writes; refresh and explicitly reconfirm. '
    'The whole plan executes atomically in foreign-key-safe order, including only its authorized history IDs. '
    'Cross-scope or surviving references return safe 409; no other lab is deleted. '
    'This is catalog metadata deletion, not secure erasure: immutable shared-hash blob bytes remain private and retained.')
IMPACT_CONFIRMATION_DESCRIPTION = (' Returns cascade_counts as distinct positive per-table counts including the root and a 64-hex confirmation_token for the complete scoped cascade. '
    'Plan counts are separate from legacy dependencies. The unused-file preview remains bounded to 50 with its full total. '
    'This read-only coherent snapshot neither deletes nor archives; cancelling requires no API write. Blob bytes remain private and retained, not securely erased.')

bearer_schema = HTTPBearer(auto_error=False, scheme_name='BearerAuth')
Cascade = Annotated[bool, Query(description='Explicitly delete the confirmed scoped catalog closure; defaults to restrictive legacy deletion. Blob bytes remain private and retained, not securely erased.')]
ConfirmationToken = Annotated[str | None, Query(pattern=r'^[0-9a-fA-F]{64}$', description='Required with cascade=true. SHA-256 full-plan fingerprint from deletion-impact; changed plans return 409 deletion_changed without writes.')]
cookie_schema = APIKeyCookie(name=COOKIE, auto_error=False, scheme_name='CookieAuth')


def error_response(status, code, message, details=None):
    return JSONResponse({'code': code, 'message': message, 'details': details}, status_code=status)


def load_token(root):
    p = reject_symlinks(root / 'operator-token')
    try:
        fd = os.open(p, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        fd = None
    if fd is not None:
        with os.fdopen(fd, 'w') as f:
            f.write(secrets.token_urlsafe(48) + '\n'); f.flush(); os.fsync(f.fileno())
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'r') as f:
        os.fchmod(f.fileno(), 0o600)
        token = f.read(1000).strip()
    if len(token) < 32: raise ValueError('invalid operator token file')
    return token


class SecurityBoundary:
    def __init__(self, app, token, allowed_hosts, root):
        self.app = app; self.token = token; self.allowed_hosts = frozenset(allowed_hosts); self.root = root

    def cookie_valid(self, value):
        try:
            expiry, nonce, signature = value.split('.')
            stamp = int(expiry)
            if stamp < int(time.time()) or stamp > int(time.time()) + SESSION_SECONDS: return False
            expected = hmac.new(self.token.encode(), f'{expiry}.{nonce}'.encode(), hashlib.sha256).hexdigest()
            return hmac.compare_digest(signature.encode('utf-8'), expected.encode('utf-8'))
        except (ValueError, AttributeError): return False

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            await self.app(scope, receive, send); return
        headers = scope['headers']
        hosts = [v.decode('latin1') for k, v in headers if k.lower() == b'host']
        if len(hosts) != 1 or hosts[0] not in self.allowed_hosts:
            await error_response(400, 'invalid_host', 'Exact advertised Host is required')(scope, receive, send); return
        origins = [v.decode('latin1') for k, v in headers if k.lower() == b'origin']
        expected_origin = scope.get('scheme', 'http') + '://' + hosts[0]
        mutating = scope['method'] not in ('GET', 'HEAD', 'OPTIONS')
        if origins and (len(origins) != 1 or origins[0] != expected_origin):
            await error_response(403, 'forbidden_origin', 'Origin does not match advertised authority')(scope, receive, send); return
        request = Request(scope)
        authorizations = [v.decode('latin1') for k, v in headers if k.lower() == b'authorization']
        bearer = len(authorizations) == 1 and authorizations[0].startswith('Bearer ') and hmac.compare_digest(authorizations[0][7:].encode('utf-8'), self.token.encode('utf-8'))
        cookie = self.cookie_valid(request.cookies.get(COOKIE, ''))
        if authorizations and not bearer: cookie = False
        scope.setdefault('state', {})['authenticated'] = bool(bearer or cookie)
        is_session = scope['path'] == '/api/v1/session'
        private = scope['path'].startswith('/api') and not is_session
        if private and not (bearer or cookie):
            await error_response(401, 'auth', 'Operator authentication required')(scope, receive, send); return
        if mutating and cookie and not bearer and not origins:
            await error_response(403, 'forbidden_origin', 'Cookie mutations require matching Origin')(scope, receive, send); return
        if mutating and any(k.lower() == b'idempotency-key' for k, _ in headers):
            await error_response(422, 'validation', 'Idempotency-Key is not supported; every successful create produces a distinct resource')(scope, receive, send); return
        if not mutating:
            await self.app(scope, receive, send); return
        cap = BODY_LIMIT if request.headers.get('content-type', '').lower().startswith('multipart/form-data') else JSON_LIMIT
        lengths = [v for k, v in headers if k.lower() == b'content-length']
        try:
            if len(lengths) > 1 or (lengths and (int(lengths[0]) < 0 or int(lengths[0]) > cap)):
                await error_response(413, 'limit', 'Request body limit exceeded')(scope, receive, send); return
        except ValueError:
            await error_response(422, 'validation', 'Invalid Content-Length')(scope, receive, send); return
        # Bound the raw stream before multipart parsing can spool any uploaded file.
        reject_symlinks(self.root)
        with tempfile.SpooledTemporaryFile(max_size=JSON_LIMIT, dir=self.root) as buffer:
            total = 0
            while True:
                message = await receive()
                if message['type'] == 'http.disconnect': return
                part = message.get('body', b''); total += len(part)
                if total > cap:
                    await error_response(413, 'limit', 'Request body limit exceeded')(scope, receive, send); return
                buffer.write(part)
                if not message.get('more_body', False): break
            buffer.seek(0)
            content_type = request.headers.get('content-type', '').lower().split(';', 1)[0].strip()
            is_json = not content_type or content_type == 'application/json' or (content_type.startswith('application/') and content_type.endswith('+json'))
            if total and is_json:
                try:
                    def unique_pairs(pairs):
                        obj = {}
                        for key, value in pairs:
                            if key in obj: raise ValueError('duplicate JSON key')
                            obj[key] = value
                        return obj
                    obj = json.loads(buffer.read(), object_pairs_hook=unique_pairs, parse_constant=lambda value: (_ for _ in ()).throw(ValueError('nonfinite JSON')))
                    stack = [(obj, 0)]
                    while stack:
                        value, depth = stack.pop()
                        if depth > 64: raise ValueError('JSON depth limit exceeded')
                        if isinstance(value, dict):
                            for key in value: key.encode('utf-8', errors='strict')
                            stack.extend((x, depth + 1) for x in value.values())
                        elif isinstance(value, list): stack.extend((x, depth + 1) for x in value)
                        elif isinstance(value, str): value.encode('utf-8', errors='strict')
                except (ValueError, UnicodeError, RecursionError):
                    await error_response(422, 'validation', 'Invalid JSON, Unicode scalar strings, duplicate keys or JSON nesting limit exceeded')(scope, receive, send); return
                buffer.seek(0)
            async def replay():
                part = buffer.read(65536)
                return {'type': 'http.request', 'body': part, 'more_body': buffer.tell() < total}
            await self.app(scope, replay, send)


def create_app(data_dir, allowed_hosts, frontend_dir=None):
    """Create an isolated catalog. Authorities include the literal port if used."""
    if not allowed_hosts or any('*' in h or '/' in h or '@' in h or not h or any(c.isspace() for c in h) for h in allowed_hosts):
        raise ValueError('allowed_hosts must contain exact advertised hosts (including port)')
    catalog = Catalog(data_dir)
    token = load_token(catalog.db.root)
    app = FastAPI(title='Lab Catalog', version='1.0.0', description='Private state catalog. No uploaded code is executed. Decimal strings have up to 6 fractional digits and a maximum of 1000000000 per exercise/criterion/score; aggregate totals use exact unbounded decimal strings. Upload limit: 64 MiB per file, 65 MiB raw multipart body including chunked transfer; other request bodies: 1 MiB, JSON nesting: 64 levels. Read-only ZIP limits: 1000 members, 8 MiB per uncompressed member and central directory, 64 MiB total uncompressed bytes, compression ratio 200. Only stored and deflate codecs are supported; encrypted, multi-disk and ZIP64 archives are blocked. Originals and member content are preserved as inert downloads; blocked inventories may be omitted when structural/count bounds fail. Separate text previews are capped at 1 MiB and use base64 for non-UTF-8 bytes. Criterion IDs may be omitted on creation or PATCH additions/replacements and are generated once; explicit IDs are preserved without label/order identity inference. Criterion labels, IDs, instructions, points and mode are semantic; order and exercise title/description are cosmetic. Criteria drafts may contain partial criterion scores with a null aggregate; aggregates require all criteria and final assessments require complete scores. Operator cookies expire after 8 hours, HttpOnly and SameSite=Strict; cookie mutations require an exact matching Origin. Forbidden Origins return 403 forbidden_origin without invalidating authentication; authentication failures return 401. PATCH and assessment PUT require current record revision. Assessment PUT also requires rubric_revision >= 1 from the exercise rules actually loaded by the editor; mismatches return 409 even for first assessments and notes-only requests. Stored stale grades require confirm_rubric_change=true to change grading values or consciously regrade under current rules. Without confirmation, unchanged grading state permits notes/source updates while preserving old score, snapshot, rubric_revision and stale status. PUT is a full assessment replacement; resubmit all intended fields. Material and evidence GET/PATCH preserve IDs; PATCH requires revision, retains omitted fields and permits explicit null only for nullable fields. New correction records start at revision 1; historical materials have no fabricated creation timestamp and unknown historical update timestamps are null. Idempotency-Key is explicitly unsupported and rejected; every successful create produces a distinct resource.', responses={code: {'model': s.Error} for code in (401, 403, 404, 409, 413, 422)})
    app.state.catalog = catalog
    app.add_middleware(SecurityBoundary, token=token, allowed_hosts=allowed_hosts, root=catalog.db.root)

    @app.exception_handler(CatalogError)
    async def catalog_error(request, exc):
        return error_response(exc.status, exc.code, exc.message, exc.details)

    @app.exception_handler(RequestValidationError)
    @app.exception_handler(ValidationError)
    async def validation_error(request, exc):
        details = [{'loc': list(e['loc']), 'type': e['type'], 'message': e['msg']} for e in exc.errors()]
        return error_response(422, 'validation', 'Request validation failed', details)

    @app.exception_handler(HTTPException)
    async def http_error(request, exc):
        return error_response(exc.status_code, 'not_found' if exc.status_code == 404 else 'validation', str(exc.detail))

    @app.exception_handler(sqlite3.Error)
    @app.exception_handler(OSError)
    async def storage_error(request, exc):
        return error_response(500, 'storage_error', 'Storage operation failed')

    @app.exception_handler(OverflowError)
    async def limit_error(request, exc):
        return error_response(413, 'limit', str(exc))

    @app.get('/health')
    def health():
        return {'status': 'ok'}

    @app.get('/api/v1/session', response_model=s.Session)
    def session(request: Request):
        return {'authenticated': request.state.authenticated}

    @app.post('/api/v1/session', response_model=s.Session)
    def login(body: s.SessionInput, response: Response, request: Request):
        if not hmac.compare_digest(body.token.encode('utf-8'), token.encode('utf-8')):
            raise CatalogError(401, 'auth', 'Invalid operator token')
        value = f'{int(time.time()) + SESSION_SECONDS}.{secrets.token_hex(16)}'
        signature = hmac.new(token.encode(), value.encode(), hashlib.sha256).hexdigest()
        response.set_cookie(COOKIE, value + '.' + signature, max_age=SESSION_SECONDS, httponly=True, samesite='strict', secure=request.url.scheme == 'https', path='/api/v1')
        return {'authenticated': True}

    @app.delete('/api/v1/session', status_code=204)
    def logout(response: Response):
        response.delete_cookie(COOKIE, path='/api/v1', httponly=True, samesite='strict')

    def authenticated(request: Request, bearer=Depends(bearer_schema), cookie=Depends(cookie_schema)):
        if not request.state.authenticated:
            raise CatalogError(401, 'auth', 'Operator authentication required')

    api = APIRouter(prefix='/api/v1', dependencies=[Depends(authenticated)])

    @api.get('/labs', response_model=s.Page[s.Lab])
    def list_labs(limit: Limit = 50, offset: Offset = 0):
        return page(catalog.list('labs'), limit, offset)

    @api.post('/labs', response_model=s.Lab, status_code=201)
    def create_lab(body: s.LabCreate):
        return catalog.create('labs', body)

    @api.get('/labs/{lab_id}', response_model=s.Lab)
    def get_lab(lab_id: str):
        return catalog.read('labs', lab_id)

    @api.patch('/labs/{lab_id}', response_model=s.Lab)
    def patch_lab(lab_id: str, body: s.LabPatch):
        return catalog.patch('labs', lab_id, body)

    @api.get('/labs/{lab_id}/deletion-impact', response_model=s.DeletionImpact,
             description='Read-only deletion diagnostics in one coherent transaction. Reports positive real blocker counts by type (including indirect assessments/history), not a deduplicated total. The files dependency counts only files referenced by materials, submissions, or evidence; unused file metadata does not block lab deletion. Lists at most 50 unreferenced file metadata IDs and literal filenames in upload order, with their full total for optional cleanup. Does not delete or archive anything.' + IMPACT_CONFIRMATION_DESCRIPTION)
    def lab_deletion_impact(lab_id: str):
        return catalog.deletion_impact('labs', lab_id)

    @api.delete('/labs/{lab_id}', status_code=204,
                description='Without cascade=true: Delete a lab with no real dependencies. Ownership/revision validation precedes transactional dependency counts. The files count includes referenced files only. If any real blocker exists, 409 details contains dependencies, unreferenced_files (at most 50), and unreferenced_files_total, and no metadata is cleaned. Otherwise all unreferenced lab upload metadata is removed together with the lab in the same write transaction; failures roll back both. Blob bytes remain immutable and shared content is preserved. No cascading deletion of associations or history, no automatic archival, and no separate user cleanup is required.' + DELETE_CONFIRMATION_DESCRIPTION)
    def delete_lab(lab_id: str, revision: DeleteRevision = None, cascade: Cascade = False, confirmation_token: ConfirmationToken = None):
        catalog.delete('labs', lab_id, revision=revision, cascade=cascade, confirmation_token=confirmation_token)

    @api.get('/labs/{lab_id}/exercises', response_model=s.Page[s.Exercise])
    def list_exercises(lab_id: str, limit: Limit = 50, offset: Offset = 0):
        return page(catalog.list('exercises', lab_id), limit, offset)

    @api.post('/labs/{lab_id}/exercises', response_model=s.Exercise, status_code=201)
    def create_exercise(lab_id: str, body: s.ExerciseCreate):
        return catalog.create('exercises', body, lab_id)

    @api.get('/labs/{lab_id}/exercises/{exercise_id}', response_model=s.Exercise)
    def get_exercise(lab_id: str, exercise_id: str):
        return catalog.read('exercises', exercise_id, lab_id)

    @api.patch('/labs/{lab_id}/exercises/{exercise_id}', response_model=s.Exercise)
    def patch_exercise(lab_id: str, exercise_id: str, body: s.ExercisePatch):
        return catalog.patch('exercises', exercise_id, body, lab_id)

    @api.get('/labs/{lab_id}/exercises/{exercise_id}/deletion-impact', response_model=s.DeletionImpact,
             description='Read-only, lab-scoped deletion diagnostics in one coherent transaction. Reports positive material, evidence, assessment and assessment_history counts; files and teams are not direct exercise dependencies. unreferenced_files is empty and unreferenced_files_total is zero. Does not delete or archive anything.' + IMPACT_CONFIRMATION_DESCRIPTION)
    def exercise_deletion_impact(lab_id: str, exercise_id: str):
        return catalog.deletion_impact('exercises', exercise_id, lab_id)

    @api.delete('/labs/{lab_id}/exercises/{exercise_id}', status_code=204,
                description='Without cascade=true: Delete an unreferenced exercise only. Ownership/revision validation precedes transactional dependency counts. Dependency conflicts return details.dependencies for materials, evidence, assessments and assessment_history, plus empty unreferenced_files and zero unreferenced_files_total. No cascading deletion or automatic archival.' + DELETE_CONFIRMATION_DESCRIPTION)
    def delete_exercise(lab_id: str, exercise_id: str, revision: DeleteRevision = None, cascade: Cascade = False, confirmation_token: ConfirmationToken = None):
        catalog.delete('exercises', exercise_id, lab_id, revision=revision, cascade=cascade, confirmation_token=confirmation_token)

    @api.get('/labs/{lab_id}/teams', response_model=s.Page[s.Team])
    def list_teams(lab_id: str, limit: Limit = 50, offset: Offset = 0):
        return page(catalog.list('teams', lab_id), limit, offset)

    @api.post('/labs/{lab_id}/teams', response_model=s.Team, status_code=201)
    def create_team(lab_id: str, body: s.TeamCreate):
        return catalog.create('teams', body, lab_id)

    @api.get('/labs/{lab_id}/teams/{team_id}', response_model=s.Team)
    def get_team(lab_id: str, team_id: str):
        return catalog.read('teams', team_id, lab_id)

    @api.patch('/labs/{lab_id}/teams/{team_id}', response_model=s.Team)
    def patch_team(lab_id: str, team_id: str, body: s.TeamPatch):
        return catalog.patch('teams', team_id, body, lab_id)

    @api.get('/labs/{lab_id}/teams/{team_id}/deletion-impact', response_model=s.DeletionImpact,
             description='Read-only, lab-scoped team deletion diagnostics in one coherent transaction. Reports positive files, submissions, assessments, assessment_history (joined through assessments) and evidence counts. Files count only team-owned metadata referenced anywhere by materials, submissions or evidence. Lists at most 50 unreferenced team file IDs and literal filenames in upload order, with their full total. Does not delete or archive anything.' + IMPACT_CONFIRMATION_DESCRIPTION)
    def team_deletion_impact(lab_id: str, team_id: str):
        return catalog.deletion_impact('teams', team_id, lab_id)

    @api.delete('/labs/{lab_id}/teams/{team_id}', status_code=204,
                description='Without cascade=true: Explicitly delete a team with no real dependencies, including its contained members and notes. Lab ownership/revision validation precedes transactional files, submissions, assessments, assessment_history and evidence dependency counts. Files count only team-owned metadata referenced anywhere by materials, submissions or evidence. Any blocker returns 409 with dependencies, unreferenced_files (at most 50) and unreferenced_files_total, with zero cleanup. Otherwise all unreferenced team upload metadata and the team are removed atomically; any storage failure rolls both back. Blob bytes, shared file metadata, other teams, the lab and immutable history remain unchanged. No cascading deletion or automatic archival.' + DELETE_CONFIRMATION_DESCRIPTION)
    def delete_team(lab_id: str, team_id: str, revision: DeleteRevision = None, cascade: Cascade = False, confirmation_token: ConfirmationToken = None):
        catalog.delete('teams', team_id, lab_id, revision=revision, cascade=cascade, confirmation_token=confirmation_token)

    async def validate_form(request: Request, allowed):
        form = await request.form()
        if 'team_id' in form and not form['team_id']:
            invalid('Empty team_id is not a shared-file selector; omit the field')
        if any(key not in allowed for key in form) or any(len(form.getlist(key)) != 1 for key in form):
            invalid('Unknown or duplicate multipart fields')

    async def file_form(request: Request):
        await validate_form(request, {'file', 'team_id'})

    async def submission_form(request: Request):
        await validate_form(request, {'file'})

    @api.post('/labs/{lab_id}/files', response_model=s.File, status_code=201, dependencies=[Depends(file_form)])
    def upload_file(lab_id: str, file: Annotated[UploadFile, UploadField()], team_id: Annotated[str | None, Form()] = None):
        return catalog.upload(lab_id, team_id, file.filename, file.file, file.content_type)

    @api.get('/labs/{lab_id}/files', response_model=s.Page[s.File])
    def list_files(lab_id: str, limit: Limit = 50, offset: Offset = 0):
        return page(catalog.list('files', lab_id), limit, offset)

    @api.delete('/labs/{lab_id}/files/{file_id}', status_code=204,
                responses={404: {'model': s.Error, 'description': 'Missing file or wrong lab; no reference details disclosed'},
                           409: {'model': s.Error, 'description': 'Referenced metadata; details.dependencies contains positive materials/submissions/evidence reference counts'}},
                description='Without cascade=true: Delete only unreferenced upload metadata scoped to this lab. Files referenced by materials, submissions (including student ZIP originals), or evidence are protected with 409 and actual reference counts in details.dependencies. Wrong-lab or missing IDs return 404. Files are immutable and have no revision precondition. Blob bytes are never removed, including shared content; associations and assessment history are never cascaded. After 204, verify removal with the existing global GET /api/v1/files/{file_id}, which returns 404.' + DELETE_CONFIRMATION_DESCRIPTION)
    def delete_unused_file(lab_id: str, file_id: str, cascade: Cascade = False, confirmation_token: ConfirmationToken = None):
        catalog.delete_file(lab_id, file_id, cascade=cascade, confirmation_token=confirmation_token)

    @api.get('/labs/{lab_id}/files/{file_id}/deletion-impact', response_model=s.DeletionImpact, description=IMPACT_CONFIRMATION_DESCRIPTION)
    def file_deletion_impact(lab_id: str, file_id: str):
        return catalog.deletion_impact('files', file_id, lab_id)

    @api.get('/files/{file_id}', response_model=s.File)
    def get_file(file_id: str):
        return catalog.read('files', file_id)

    def file_bytes(file_id):
        f = catalog.read('files', file_id)
        try:
            return f, catalog.blobs.read(f['sha256'], f['size'])
        except (ValueError, OSError):
            raise CatalogError(409, 'conflict', 'Stored file is unavailable or failed integrity validation') from None

    @api.head('/files/{file_id}/download', response_class=Response, include_in_schema=False)
    @api.get('/files/{file_id}/download', response_class=Response)
    def download(file_id: str):
        f, data = file_bytes(file_id)
        return inert_download(data, f['filename'])

    def inert_download(data, filename):
        return Response(data, media_type='application/octet-stream', headers={'Content-Disposition': "attachment; filename=download; filename*=UTF-8''" + quote(filename, safe=''), 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'", 'Cache-Control': 'no-store'})

    @api.get('/files/{file_id}/text', response_model=s.TextContent)
    def file_text(file_id: str):
        _, data = file_bytes(file_id)
        return text_content(data)

    @api.get('/labs/{lab_id}/materials', response_model=s.Page[s.Material])
    def list_materials(lab_id: str, limit: Limit = 50, offset: Offset = 0):
        return page(catalog.list('materials', lab_id), limit, offset)

    @api.post('/labs/{lab_id}/materials', response_model=s.Material, status_code=201)
    def create_material(lab_id: str, body: s.MaterialCreate):
        return catalog.material(lab_id, body)

    @api.get('/labs/{lab_id}/materials/{material_id}', response_model=s.Material)
    def get_material(lab_id: str, material_id: str):
        return catalog.read('materials', material_id, lab_id)

    @api.patch('/labs/{lab_id}/materials/{material_id}', response_model=s.Material)
    def patch_material(lab_id: str, material_id: str, body: s.MaterialPatch):
        return catalog.patch_record('materials', lab_id, material_id, body)

    @api.delete('/labs/{lab_id}/materials/{material_id}', status_code=204, description='Without cascade=true delete only the material record. Confirmed deletion also removes attached file metadata only if globally unreferenced after the plan.' + DELETE_CONFIRMATION_DESCRIPTION)
    def delete_material(lab_id: str, material_id: str, revision: DeleteRevision = None, cascade: Cascade = False, confirmation_token: ConfirmationToken = None):
        catalog.delete('materials', material_id, lab_id, revision=revision, cascade=cascade, confirmation_token=confirmation_token)

    @api.get('/labs/{lab_id}/materials/{material_id}/deletion-impact', response_model=s.DeletionImpact, description=IMPACT_CONFIRMATION_DESCRIPTION)
    def material_deletion_impact(lab_id: str, material_id: str):
        return catalog.deletion_impact('materials', material_id, lab_id)

    @api.get('/labs/{lab_id}/teams/{team_id}/submissions', response_model=s.Page[s.Submission])
    def list_submissions(lab_id: str, team_id: str, limit: Limit = 50, offset: Offset = 0):
        return page(catalog.team_list('submissions', lab_id, team_id), limit, offset)

    @api.post('/labs/{lab_id}/teams/{team_id}/submissions', response_model=s.Submission, status_code=201, dependencies=[Depends(submission_form)])
    def upload_submission(lab_id: str, team_id: str, file: Annotated[UploadFile, UploadField()]):
        return catalog.upload(lab_id, team_id, file.filename, file.file, file.content_type, submission=True)

    @api.get('/submissions/{submission_id}', response_model=s.Submission)
    def get_submission(submission_id: str):
        return catalog.read('submissions', submission_id)

    @api.get('/labs/{lab_id}/teams/{team_id}/submissions/{submission_id}/deletion-impact', response_model=s.DeletionImpact, description=IMPACT_CONFIRMATION_DESCRIPTION)
    def submission_deletion_impact(lab_id: str, team_id: str, submission_id: str):
        return catalog.deletion_impact('submissions', submission_id, lab_id, team_id)

    @api.delete('/labs/{lab_id}/teams/{team_id}/submissions/{submission_id}', status_code=204, description='Without cascade=true retain restrictive dependencies. Confirmed deletion removes linked evidence and assessments with current or historical submission_id links, all their history, and original file metadata only if globally unreferenced. Submissions are immutable and have no revision parameter. Verify absence using global GET submissions/{submission_id}.' + DELETE_CONFIRMATION_DESCRIPTION)
    def delete_submission(lab_id: str, team_id: str, submission_id: str, cascade: Cascade = False, confirmation_token: ConfirmationToken = None):
        catalog.delete('submissions', submission_id, lab_id, team_id=team_id, cascade=cascade, confirmation_token=confirmation_token)

    @api.get('/submissions/{submission_id}/members', response_model=s.Page[s.ArchiveMember])
    def list_members(submission_id: str, limit: Limit = 50, offset: Offset = 0):
        return page(catalog.read('submissions', submission_id)['members'], limit, offset)

    def submission_member_bytes(submission_id, path):
        sub = catalog.read('submissions', submission_id)
        if sub['archive_status'] != 'valid': invalid('Archive is blocked; original bytes remain downloadable')
        _, data = file_bytes(sub['file_id'])
        try:
            return member_bytes(data, path)
        except LookupError:
            missing()
        except DECODE_ERRORS:
            invalid('Unsafe, blocked or corrupt archive member')

    @api.head('/submissions/{submission_id}/members/content', response_class=Response, include_in_schema=False)
    @api.get('/submissions/{submission_id}/members/content', response_class=Response,
             responses={200: {'description': 'Original bounded member bytes as an inert attachment', 'content': {'application/octet-stream': {'schema': {'type': 'string', 'format': 'binary'}}}}})
    def member_content(submission_id: str, path: Annotated[str, Query(min_length=1, max_length=65535)]):
        return inert_download(submission_member_bytes(submission_id, path), path.rstrip('/').rsplit('/', 1)[-1])

    @api.get('/submissions/{submission_id}/members/text', response_model=s.TextContent)
    def member_text(submission_id: str, path: Annotated[str, Query(min_length=1, max_length=65535)]):
        return text_content(submission_member_bytes(submission_id, path), path)

    @api.get('/labs/{lab_id}/teams/{team_id}/assessments/{exercise_id}', response_model=s.Assessment)
    def get_assessment(lab_id: str, team_id: str, exercise_id: str):
        return catalog.get_assessment(lab_id, team_id, exercise_id)

    @api.put('/labs/{lab_id}/teams/{team_id}/assessments/{exercise_id}', response_model=s.Assessment)
    def put_assessment(lab_id: str, team_id: str, exercise_id: str, body: s.AssessmentPut):
        return catalog.put_assessment(lab_id, team_id, exercise_id, body)

    @api.get('/labs/{lab_id}/teams/{team_id}/assessments/{exercise_id}/deletion-impact', response_model=s.DeletionImpact, description=IMPACT_CONFIRMATION_DESCRIPTION)
    def assessment_deletion_impact(lab_id: str, team_id: str, exercise_id: str):
        return catalog.deletion_impact('assessments', exercise_id, lab_id, team_id)

    @api.delete('/labs/{lab_id}/teams/{team_id}/assessments/{exercise_id}', status_code=204, description='Without cascade=true history blocks deletion. Confirmed deletion removes only the actual assessment for this team/exercise and its history; independent evidence survives. Missing assessment DELETE is 404; subsequent GET returns the ungraded default with id=null revision=0 and empty history.' + DELETE_CONFIRMATION_DESCRIPTION)
    def delete_assessment(lab_id: str, team_id: str, exercise_id: str, revision: DeleteRevision = None, cascade: Cascade = False, confirmation_token: ConfirmationToken = None):
        catalog.delete('assessments', exercise_id, lab_id, team_id=team_id, revision=revision, cascade=cascade, confirmation_token=confirmation_token)

    @api.get('/labs/{lab_id}/teams/{team_id}/assessments/{exercise_id}/history', response_model=s.Page[s.Assessment])
    def assessment_history(lab_id: str, team_id: str, exercise_id: str, limit: Limit = 50, offset: Offset = 0):
        return page(catalog.history(lab_id, team_id, exercise_id), limit, offset)

    @api.get('/labs/{lab_id}/teams/{team_id}/evidence', response_model=s.Page[s.Evidence])
    def list_evidence(lab_id: str, team_id: str, exercise_id: str | None = None, limit: Limit = 50, offset: Offset = 0):
        return page(catalog.team_list('evidence', lab_id, team_id, exercise_id), limit, offset)

    @api.post('/labs/{lab_id}/teams/{team_id}/evidence', response_model=s.Evidence, status_code=201)
    def create_evidence(lab_id: str, team_id: str, body: s.EvidenceCreate):
        return catalog.evidence(lab_id, team_id, body)

    @api.get('/labs/{lab_id}/teams/{team_id}/evidence/{evidence_id}', response_model=s.Evidence)
    def get_evidence(lab_id: str, team_id: str, evidence_id: str):
        return catalog.read_evidence(lab_id, team_id, evidence_id)

    @api.patch('/labs/{lab_id}/teams/{team_id}/evidence/{evidence_id}', response_model=s.Evidence)
    def patch_evidence(lab_id: str, team_id: str, evidence_id: str, body: s.EvidencePatch):
        return catalog.patch_record('evidence', lab_id, evidence_id, body, team_id)

    @api.delete('/labs/{lab_id}/teams/{team_id}/evidence/{evidence_id}', status_code=204, description='Without cascade=true delete only selected evidence. Confirmed deletion also removes its attached file metadata only if globally unreferenced; submissions and independent assessments survive.' + DELETE_CONFIRMATION_DESCRIPTION)
    def delete_evidence(lab_id: str, team_id: str, evidence_id: str, revision: DeleteRevision = None, cascade: Cascade = False, confirmation_token: ConfirmationToken = None):
        catalog.delete_evidence(lab_id, team_id, evidence_id, revision=revision, cascade=cascade, confirmation_token=confirmation_token)

    @api.get('/labs/{lab_id}/teams/{team_id}/evidence/{evidence_id}/deletion-impact', response_model=s.DeletionImpact, description=IMPACT_CONFIRMATION_DESCRIPTION)
    def evidence_deletion_impact(lab_id: str, team_id: str, evidence_id: str):
        return catalog.deletion_impact('evidence', evidence_id, lab_id, team_id)

    @api.get('/labs/{lab_id}/overview', response_model=s.Overview)
    def overview(lab_id: str, limit: Limit = 50, offset: Offset = 0):
        return catalog.overview(lab_id, limit, offset)

    @api.get('/labs/{lab_id}/export', response_model=s.Export)
    def export(lab_id: str):
        return catalog.export(lab_id)

    app.include_router(api)
    if frontend_dir is not None:
        public = reject_symlinks(frontend_dir)
        if not public.is_dir() or catalog.db.root == public or catalog.db.root in public.parents or public in catalog.db.root.parents:
            raise ValueError('frontend_dir must be an existing directory separate from private state')
        extensions = {'.html', '.js', '.mjs', '.css', '.svg', '.png', '.jpg', '.jpeg', '.ico', '.webp', '.woff', '.woff2', '.map', '.json'}
        whitelist = {}
        for directory, dirs, filenames in os.walk(public, followlinks=False):
            dirs[:] = [d for d in dirs if not (Path(directory) / d).is_symlink()]
            for name in filenames:
                p = Path(directory) / name
                if not p.is_symlink() and p.is_file() and p.suffix in extensions:
                    whitelist[p.relative_to(public).as_posix()] = p
        if 'index.html' not in whitelist: raise ValueError('frontend_dir requires index.html')

        @app.api_route('/{path:path}', methods=['GET', 'HEAD'], include_in_schema=False)
        def frontend(path: str):
            if path.startswith('api/') or path == 'api' or any(part in ('.', '..') for part in path.split('/')) or '\\' in path:
                missing()
            target = whitelist.get(path or 'index.html')
            if target is None and path.split('/')[0] in ('labs', 'teams', 'exercises', 'catalog') and '.' not in path:
                target = whitelist['index.html']
            if target is None: missing()
            try: reject_symlinks(target)
            except ValueError: missing()
            return FileResponse(target, headers={'X-Content-Type-Options': 'nosniff'})

    return app
