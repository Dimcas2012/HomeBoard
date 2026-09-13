import datetime
import sys
from pathlib import Path

from daphne import __version__
from daphne.management.commands.runserver import Command as DaphneRunserverCommand
from daphne.management.commands.runserver import get_default_application
from django.apps import apps
from django.conf import settings
from django.contrib.staticfiles.handlers import ASGIStaticFilesHandler


class Command(DaphneRunserverCommand):
    default_addr = '10.1.10.123'
    default_port = '8007'

    def add_arguments(self, parser):
        super().add_arguments(parser)
        parser.add_argument(
            '--no-ssl',
            action='store_true',
            help='Run plain HTTP (iPhone camera will not work on LAN)',
        )

    def inner_run(self, *args, **options):
        if not options.get('use_asgi', True):
            return super().inner_run(*args, **options)

        cert = Path(settings.BASE_DIR) / 'certs' / 'cert.pem'
        key = Path(settings.BASE_DIR) / 'certs' / 'key.pem'
        use_ssl = (not options.get('no_ssl')) and cert.exists() and key.exists()
        self.protocol = 'https' if use_ssl else 'http'

        self.stdout.write('Performing system checks...\n\n')
        self.check(display_num_errors=True)
        self.check_migrations()

        quit_command = 'CTRL-BREAK' if sys.platform == 'win32' else 'CONTROL-C'
        now = datetime.datetime.now().strftime('%B %d, %Y - %X')
        self.stdout.write(now)
        self.stdout.write(
            (
                'Django version %(version)s, using settings %(settings)r\n'
                'Starting ASGI/Daphne version %(daphne_version)s development server'
                ' at %(protocol)s://%(addr)s:%(port)s/\n'
                'Quit the server with %(quit_command)s.\n'
            )
            % {
                'version': self.get_version(),
                'daphne_version': __version__,
                'settings': settings.SETTINGS_MODULE,
                'protocol': self.protocol,
                'addr': '[%s]' % self.addr if self._raw_ipv6 else self.addr,
                'port': self.port,
                'quit_command': quit_command,
            }
        )
        if use_ssl:
            self.stdout.write(self.style.WARNING(
                'Self-signed TLS: на iPhone відкрийте URL, натисніть «Показати деталі» → «Відвідати сайт».\n'
            ))

        host = self.addr.strip('[]').replace(':', r'\:')
        if use_ssl:
            endpoints = [
                'ssl:%s:interface=%s:privateKey=%s:certKey=%s'
                % (int(self.port), host, key.as_posix(), cert.as_posix())
            ]
        else:
            endpoints = ['tcp:port=%d:interface=%s' % (int(self.port), host)]

        staticfiles_installed = apps.is_installed('django.contrib.staticfiles')
        use_static_handler = options.get('use_static_handler', staticfiles_installed)
        insecure_serving = options.get('insecure_serving', False)
        if use_static_handler and (settings.DEBUG or insecure_serving):
            application = ASGIStaticFilesHandler(get_default_application())
        else:
            application = get_default_application()

        try:
            self.server_cls(
                application=application,
                endpoints=endpoints,
                signal_handlers=not options['use_reloader'],
                action_logger=self.log_action,
                http_timeout=self.http_timeout,
                root_path=getattr(settings, 'FORCE_SCRIPT_NAME', '') or '',
                websocket_handshake_timeout=self.websocket_handshake_timeout,
                websocket_max_message_size=self.websocket_max_message_size,
                websocket_max_frame_size=self.websocket_max_frame_size,
            ).run()
        except KeyboardInterrupt:
            shutdown_message = options.get('shutdown_message', '')
            if shutdown_message:
                self.stdout.write(shutdown_message)
