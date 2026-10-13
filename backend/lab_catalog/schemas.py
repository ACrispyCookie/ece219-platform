"""Version-one wire models. Decimal points are strings, never JSON floats."""
from decimal import Decimal
from typing import Annotated, Generic, Literal, TypeVar
from urllib.parse import urlsplit
from uuid import uuid4
import re

from pydantic import BaseModel, ConfigDict, Field, BeforeValidator, model_validator


def points(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9]{1,10}(?:\.[0-9]{1,6})?', value):
        raise ValueError('points must be a nonnegative decimal string with at most six fractional digits')
    if Decimal(value) > Decimal('1000000000'):
        raise ValueError('points exceed 1000000000')
    return value


Points = Annotated[str, BeforeValidator(points)]
Title = Annotated[str, Field(min_length=1, max_length=500)]
Text = Annotated[str, Field(max_length=100000)]
Identifier = Annotated[str, Field(min_length=1, max_length=200)]
Source = Literal['human', 'agent', 'import']


class Model(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)

    @model_validator(mode='before')
    @classmethod
    def unicode_scalars(cls, value):
        # JSON escapes can decode to lone surrogates even though the wire bytes
        # are valid UTF-8. Validate keys as well as values without repairing them.
        stack = [value]
        seen = set()
        while stack:
            item = stack.pop()
            if isinstance(item, str):
                try:
                    item.encode('utf-8', errors='strict')
                except UnicodeEncodeError:
                    raise ValueError('strings and object keys must contain only Unicode scalar values') from None
            elif isinstance(item, (dict, list, tuple)):
                # Leave cyclic/non-JSON data to the existing content validator.
                if id(item) in seen: continue
                seen.add(id(item))
                if isinstance(item, dict):
                    stack.extend(item.keys())
                    stack.extend(item.values())
                else:
                    stack.extend(item)
        return value


class Error(Model):
    code: str
    message: str
    details: list | dict | None = None


class DeletionDependency(Model):
    kind: Literal['labs', 'exercises', 'teams', 'files', 'materials', 'submissions', 'assessments', 'assessment_history', 'evidence']
    count: Annotated[int, Field(ge=1)]


class UnreferencedFile(Model):
    id: str
    filename: str


class DeletionImpact(Model):
    dependencies: list[DeletionDependency]
    unreferenced_files: Annotated[list[UnreferencedFile], Field(max_length=50)]
    unreferenced_files_total: Annotated[int, Field(ge=0)]
    cascade_counts: list[DeletionDependency]
    confirmation_token: Annotated[str, Field(pattern=r'^[0-9a-f]{64}$')]


class SessionInput(Model):
    token: Annotated[str, Field(min_length=1, max_length=1000)]


class Session(Model):
    authenticated: bool


class Stamped(Model):
    id: str
    created_at: str
    updated_at: str
    revision: int


class LabCreate(Model):
    title: Title
    description: Text = ''
    archived: bool = False


class LabPatch(Model):
    revision: Annotated[int, Field(ge=0)]
    title: Title | None = None
    description: Text | None = None
    archived: bool | None = None


class Lab(LabCreate, Stamped):
    pass


class Criterion(Model):
    id: Identifier
    label: Title
    max_points: Points
    instructions: Text = ''


class CriterionCreate(Criterion):
    # Missing IDs represent new identities, including additions/replacements in PATCH.
    id: Identifier = Field(default_factory=lambda: str(uuid4()))


CriterionType = TypeVar('CriterionType', bound=Criterion)


class ExerciseDefinition(Model, Generic[CriterionType]):
    title: Title
    description: Text = ''
    position: Annotated[int, Field(ge=0, le=1000000)] = 0
    max_points: Points = '0'
    grading_mode: Literal['manual', 'criteria'] = 'manual'
    grading_instructions: Text = ''
    criteria: Annotated[list[CriterionType], Field(max_length=200)] = Field(default_factory=list)
    archived: bool = False

    @model_validator(mode='after')
    def rubric(self):
        if self.grading_mode == 'manual' and self.criteria:
            raise ValueError('manual mode cannot have criteria')
        if self.grading_mode == 'criteria':
            if not self.criteria or sum((Decimal(x.max_points) for x in self.criteria), Decimal(0)) != Decimal(self.max_points):
                raise ValueError('criteria must be nonempty and sum exactly to max_points')
        if len({x.id for x in self.criteria}) != len(self.criteria):
            raise ValueError('duplicate criterion ids')
        return self


class ExerciseCreate(ExerciseDefinition[CriterionCreate]):
    pass


class ExercisePatch(Model):
    revision: Annotated[int, Field(ge=0)]
    title: Title | None = None
    description: Text | None = None
    position: Annotated[int, Field(ge=0, le=1000000)] | None = None
    max_points: Points | None = None
    grading_mode: Literal['manual', 'criteria'] | None = None
    grading_instructions: Text | None = None
    criteria: Annotated[list[CriterionCreate], Field(max_length=200)] | None = None
    archived: bool | None = None


class Exercise(ExerciseDefinition[Criterion], Stamped):
    lab_id: str
    rubric_revision: int


class Member(Model):
    student_id: Identifier
    name: Annotated[str, Field(max_length=500)]


class TeamCreate(Model):
    label: Title
    members: Annotated[list[Member], Field(max_length=1000)] = Field(default_factory=list)
    membership_complete: bool = False
    notes: Text = ''
    archived: bool = False

    @model_validator(mode='after')
    def membership(self):
        if self.membership_complete and not self.members:
            raise ValueError('complete membership requires at least one member')
        if len({x.student_id for x in self.members}) != len(self.members):
            raise ValueError('duplicate student ids within team')
        return self


class TeamPatch(Model):
    revision: Annotated[int, Field(ge=0)]
    label: Title | None = None
    members: Annotated[list[Member], Field(max_length=1000)] | None = None
    membership_complete: bool | None = None
    notes: Text | None = None
    archived: bool | None = None


class Team(TeamCreate, Stamped):
    lab_id: str


class File(Model):
    id: str
    lab_id: str
    team_id: str | None
    filename: str
    sha256: str
    size: int
    media_type: str
    created_at: str


class MaterialCreate(Model):
    file_id: Identifier
    exercise_id: Identifier | None = None
    role: Literal['handout', 'grader', 'solution', 'guidelines', 'other']
    title: Title
    description: Text = ''


class MaterialPatch(Model):
    revision: Annotated[int, Field(ge=1)]
    # Defaults allow omission, not null: supplied values still validate against
    # their nonnullable annotations, and service merging uses exclude_unset.
    file_id: Identifier = Field(default=None)
    exercise_id: Identifier | None = None
    role: Literal['handout', 'grader', 'solution', 'guidelines', 'other'] = Field(default=None)
    title: Title = Field(default=None)
    description: Text = Field(default=None)


class Material(MaterialCreate):
    id: str
    lab_id: str
    revision: int
    updated_at: str | None


class ArchiveMember(Model):
    path: str
    size: int
    compressed_size: int
    is_directory: bool
    status: Literal['valid', 'blocked']
    errors: list[str]


class Submission(Model):
    id: str
    lab_id: str
    team_id: str
    file_id: str
    filename: str
    sha256: str
    created_at: str
    archive_status: Literal['valid', 'blocked']
    archive_errors: list[str]
    members: list[ArchiveMember]


class RubricSnapshot(Model):
    max_points: Points
    grading_mode: Literal['manual', 'criteria']
    grading_instructions: str
    criteria: list[Criterion]
    rubric_revision: int


class AssessmentPut(Model):
    revision: Annotated[int, Field(ge=0)]
    rubric_revision: Annotated[int, Field(ge=1)]
    confirm_rubric_change: bool = False
    submission_id: Identifier | None = None
    status: Literal['ungraded', 'draft', 'final'] = 'ungraded'
    score: Points | None = None
    criterion_scores: dict[str, Points] = Field(default_factory=dict)
    notes: Text = ''
    source: Source = 'human'


class Assessment(Model):
    id: str | None
    team_id: str
    exercise_id: str
    submission_id: str | None
    status: Literal['ungraded', 'draft', 'final']
    score: Points | None
    criterion_scores: dict[str, Points]
    notes: str
    source: Source
    revision: int
    rubric_revision: int
    rubric_snapshot: RubricSnapshot
    rubric_stale: bool
    created_at: str | None
    updated_at: str | None


class EvidenceCreate(Model):
    exercise_id: Identifier
    submission_id: Identifier | None = None
    kind: Literal['text', 'link', 'file', 'result']
    title: Title
    text: Text = ''
    url: Annotated[str, Field(max_length=10000)] | None = None
    file_id: Identifier | None = None
    data: dict | list | str | int | float | bool | None = None
    source: Source = 'human'

    @model_validator(mode='after')
    def content(self):
        import json
        try:
            json.dumps(self.data, allow_nan=False)
        except (ValueError, TypeError, RecursionError):
            raise ValueError('evidence data must be finite JSON') from None
        if self.url is not None:
            u = urlsplit(self.url)
            if u.scheme not in ('http', 'https') or not u.hostname or u.username or u.password or any(ord(c) < 32 for c in self.url):
                raise ValueError('only absolute http(s) URLs without credentials are allowed')
        if self.kind == 'text' and not self.text:
            raise ValueError('text evidence requires text')
        if self.kind == 'link' and not self.url:
            raise ValueError('link evidence requires url')
        if self.kind == 'file' and not self.file_id:
            raise ValueError('file evidence requires file_id')
        if self.kind == 'result' and self.data is None:
            raise ValueError('result evidence requires data')
        return self


class EvidencePatch(Model):
    revision: Annotated[int, Field(ge=1)]
    exercise_id: Identifier = Field(default=None)
    submission_id: Identifier | None = None
    kind: Literal['text', 'link', 'file', 'result'] = Field(default=None)
    title: Title = Field(default=None)
    text: Text = Field(default=None)
    url: Annotated[str, Field(max_length=10000)] | None = None
    file_id: Identifier | None = None
    data: dict | list | str | int | float | bool | None = None
    source: Source = Field(default=None)


class Evidence(EvidenceCreate):
    id: str
    lab_id: str
    team_id: str
    created_at: str
    revision: int
    updated_at: str | None


T = TypeVar('T')


class Page(Model, Generic[T]):
    items: list[T]
    total: int
    limit: int
    offset: int


class TextContent(Model):
    text: str | None
    base64: str | None = None
    size: int
    truncated: bool = False
    path: str | None = None


class OverviewRow(Model):
    team: Team
    submissions_count: int
    assessments: list[Assessment]
    awarded_points: str
    total_points: str
    grade_complete: bool


class OverviewStats(Model):
    teams: int
    active_teams: int
    active_exercises: int
    complete_teams: int
    submissions: int


class Overview(Model):
    lab: Lab
    exercises: list[Exercise]
    rows: list[OverviewRow]
    total: int
    limit: int
    offset: int
    stats: OverviewStats


class Export(Model):
    schema_version: int
    lab: Lab
    exercises: list[Exercise]
    teams: list[Team]
    files: list[File]
    materials: list[Material]
    submissions: list[Submission]
    assessments: list[Assessment]
    assessment_history: list[Assessment]
    evidence: list[Evidence]
