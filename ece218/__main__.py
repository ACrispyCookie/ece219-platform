"""Executable stdlib CLI. See package documentation for schema and policy."""
import argparse
import json
from pathlib import Path
import sys

from .core import Store, read_json, write_json


def main(argv=None):
    parser = argparse.ArgumentParser(description='Private multi-lab ingest and draft review; no automatic grading.')
    parser.add_argument('--workspace', default='workspace', help='private storage root (default: ./workspace)')
    commands = parser.add_subparsers(dest='operation', required=True)
    for name in ('import', 'init'):
        cmd = commands.add_parser(name, help='ingest a JSON manifest and retain every archive version')
        cmd.add_argument('manifest')
    commands.add_parser('list', help='list labs and inventory counts')
    cmd = commands.add_parser('prepare', help='prepare source bundles, without running an agent')
    cmd.add_argument('lab')
    cmd.add_argument('--version')
    cmd = commands.add_parser('review-import', help='strictly validate a report JSON or array, store draft only')
    cmd.add_argument('lab')
    cmd.add_argument('report')
    cmd = commands.add_parser('evidence-import', help='import historical report JSON by exact archive filename, not as a current run/review')
    cmd.add_argument('lab')
    cmd.add_argument('report')
    cmd.add_argument('--versions', metavar='JSON', help='optional JSON archive-name to version-ID mapping for ambiguous names')
    cmd.add_argument('--source', default='historical CSV (19/25 suite)')
    cmd = commands.add_parser('run-import', help='attach a trusted runner JSON to an exact source member; not a final grade')
    cmd.add_argument('lab')
    cmd.add_argument('version')
    cmd.add_argument('report')
    cmd.add_argument('--source', required=True, help='exact source member path in this archive')
    cmd = commands.add_parser('review-run', help='explicit trusted external reviewer; shlex argv, no shell, JSON stdin/stdout')
    cmd.add_argument('lab')
    cmd.add_argument('--command', required=True)
    cmd.add_argument('--version')
    cmd.add_argument('--timeout', type=float, default=120, help='finite timeout in seconds, maximum 3600')
    cmd = commands.add_parser('report', help='all-version team overview, drafts and separate human decisions')
    cmd.add_argument('lab')
    cmd.add_argument('--json', metavar='PATH', help='also export aggregate JSON to this path')
    cmd = commands.add_parser('serve', help='serve web/ assets and whitelisted API only; default localhost')
    cmd.add_argument('--host', default='127.0.0.1')
    cmd.add_argument('--port', type=int, default=3458)
    cmd.add_argument('--hostLAN', dest='host_lan', help='explicit advertised hostname/IPv4; required for nonlocal binding (no auth)')
    args = parser.parse_args(argv)
    try:
        store = Store(args.workspace)
        if args.operation in ('import', 'init'):
            result = store.import_lab(args.manifest)
        elif args.operation == 'list':
            result = store.list_labs()
        elif args.operation == 'prepare':
            result = store.prepare(args.lab, args.version)
        elif args.operation == 'review-import':
            result = store.review_import(args.lab, read_json(args.report))
        elif args.operation == 'evidence-import':
            result = store.evidence_import(args.lab, read_json(args.report), read_json(args.versions) if args.versions else None, args.source)
        elif args.operation == 'run-import':
            result = store.run_import(args.lab, args.version, args.source, read_json(args.report))
        elif args.operation == 'review-run':
            result = store.review_run(args.lab, args.command, args.version, args.timeout)
        elif args.operation == 'report':
            result = store.report(args.lab)
            if args.json:
                write_json(Path(args.json), result)
        else:
            from .server import create_server
            server = create_server(store, host=args.host, port=args.port, host_lan=args.host_lan)
            advertised = args.host_lan or args.host
            print('Serving http://' + advertised + ':' + str(server.server_address[1]), flush=True)
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass
            finally:
                server.server_close()
            return 0
        print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))
        return 1 if result.get('errors') else 0
    except (ValueError, OSError, TypeError, KeyError) as exc:
        print('error: ' + str(exc), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
