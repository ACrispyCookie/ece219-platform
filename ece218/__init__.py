"""Multi-lab private ingestion and source-backed draft review.

Run ``python3 -m ece218 --workspace workspace --help`` for commands.
Storage: workspace/labs/<labId>/lab.json and private materials/, archives/,
submissions/<versionId>/, bundles/, reviews/, notes/, evidence/ directories.

Manifest paths are relative to the manifest file. Required fields: id, title,
exercises [{id,title}], materials [{role,path}], submissions (directory).
Roles: handout, guidelines, grader, testcases, solution. Optional teams mapping
is {archiveFilename: [studentId,...]}; student IDs are strings to retain zeros.
Optional explicit numerical rubric: {exerciseId: {maxScore: nonnegativeNumber}}.
No grades or weights are inferred when the rubric is absent.
Weight-only metadata does NOT authorize numerical scoring or a conversion formula.
Extra material/exercise metadata is preserved in inventory, API, and bundles.

Archive formats are identified by magic, not extension. Archive-content hashes
plus filename hashes preserve equal-content duplicates.
Reimports preserve earlier versions; archives with unresolved identity require
mapping before preparation. ZIP limits: 10000 members, 32 MiB/member, 128 MiB
expanded, 200:1 ratio; traversal, symlinks, encrypted and special files blocked.
RAR is retained but blocked because a validated RAR extractor is not provided.
PDF text uses optional pypdf or installed pdftotext; missing/unreadable/image-only
PDF extraction is explicit. DOCX text uses stdlib ZIP/XML. No input is executed.

Review JSON requires schemaVersion=1, labId, teamId, versionId, inputHash,
summary and exercises [{id,status,summary,findings,oralQuestions,score?}].
Statuses: correct, partial, incorrect, missing, review_needed. Findings:
{severity: info|warning|error, message, citations:[{path,line?|page?,quote?}]}.
Citation paths are exactly the bundle source paths; text/DOCX needs a line,
PDF needs a page; quotes must occur at that location. All exercises required.
Review import accepts a single report or a JSON array, validated before writes.
Reviews remain drafts; separate human notes use text, decision
(pending|approved|needs_changes), and optional string grade.

review-run is opt-in: shlex argv, no shell, complete bundle JSON on stdin,
report JSON on stdout, default 120-second timeout, stderr/failure evidence.
The external reviewer is trusted operator code, NOT a student sandbox. The web
API can prepare bundles but cannot run reviewers, graders or student programs.
Localhost serving requires exact Host and same-Origin mutation requests.
evidence-import <lab> <historical-report.json> links historical groups/versions
or a list of legacy version objects by exact archive filename. Ambiguous same-name
versions require --versions <archive-to-version-map.json>. Stores source/legacy
separately from current run evidence; old 19/25 results never become current 19/22
results or agent reviews. Bundles carry clearly labeled historical context.
LAN binding requires --hostLAN hostname/IP and exposes private student data
without authentication: use only on a trusted network, or a protected proxy.
"""
from .core import Store

__all__ = ['Store']
