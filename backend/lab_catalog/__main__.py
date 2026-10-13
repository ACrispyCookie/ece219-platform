"""Run the catalog with an explicit bind address and advertised authority."""
import argparse

from .api import create_app


def main():
    parser = argparse.ArgumentParser(prog='lab_catalog')
    commands = parser.add_subparsers(dest='command', required=True)
    serve = commands.add_parser('serve', help='Serve the private catalog and optional built SPA')
    serve.add_argument('--data-dir', required=True)
    serve.add_argument('--host', default='127.0.0.1')
    serve.add_argument('--port', type=int, default=3457)
    serve.add_argument('--allowed-host', action='append', default=None, help='Exact advertised host:port; repeat for additional authorities')
    serve.add_argument('--frontend-dir', default=None)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535: parser.error('--port must be between 1 and 65535')
    host = f'[{args.host}]' if ':' in args.host and not args.host.startswith('[') else args.host
    allowed = args.allowed_host or [f'{host}:{args.port}']
    if args.host in ('0.0.0.0', '::') and not args.allowed_host:
        parser.error('wildcard bind addresses require --allowed-host with actual advertised host:port')
    app = create_app(args.data_dir, allowed, args.frontend_dir)
    import uvicorn
    uvicorn.run(app, host=args.host, port=args.port, proxy_headers=False, access_log=False)


if __name__ == '__main__':
    main()
