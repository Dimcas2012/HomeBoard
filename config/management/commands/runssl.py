"""Запуск HomeBoard з TLS — потрібно для камери на iPhone (getUserMedia)."""

import datetime
import os
import sys
from pathlib import Path

from daphne import __version__
from daphne.management.commands.runserver import Command as DaphneCommand
from daphne.management.commands.runserver import get_default_application
from daphne.server import Server
from django.apps import apps
from django.conf import settings
from django.contrib.staticfiles.handlers import ASGIStaticFilesHandler
from django.core.management.base import BaseCommand, CommandError


class Command(BaseCommand):
    help = 'ASGI-сервер з HTTPS на 10.1.10.123:8007 (камера на телефоні)'

    def add_arguments(self, parser):
        parser.add_argument('--addr', default='10.1.10.123')
        parser.add_argument('--port', default='8007')
        parser.add_argument('--noreload', action='store_true')

    def handle(self, *args, **options):
        addr = options['addr']
        port = str(options['port'])
        # SSL-шляхи відносні до cwd
        os.chdir(settings.BASE_DIR)
        cert = Path(settings.BASE_DIR) / 'certs' / 'cert.pem'
        key = Path(settings.BASE_DIR) / 'certs' / 'key.pem'
        if not cert.exists() or not key.exists():
            raise CommandError(f'Немає сертифікатів: {cert} / {key}')

        # Reuse Daphne logging helpers
        daphne_cmd = DaphneCommand()
        daphne_cmd.stdout = self.stdout
        daphne_cmd.stderr = self.stderr
        daphne_cmd.style = self.style
        daphne_cmd.http_timeout = None
        daphne_cmd.websocket_handshake_timeout = 5
        daphne_cmd.websocket_max_message_size = getattr(
            settings, 'DAPHNE_WEBSOCKET_MAX_MESSAGE_SIZE', 1024 * 1024
        )
        daphne_cmd.websocket_max_frame_size = getattr(
            settings, 'DAPHNE_WEBSOCKET_MAX_FRAME_SIZE', 1024 * 1024
        )

        quit_command = 'CTRL-BREAK' if sys.platform == 'win32' else 'CONTROL-C'
        now = datetime.datetime.now().strftime('%B %d, %Y - %X')
        self.stdout.write(now)
        self.stdout.write(
            f"Django {__import__('django').get_version()}, Daphne {__version__}\n"
            f'Starting HTTPS server at https://{addr}:{port}/\n'
            f'Quit with {quit_command}.\n'
        )
        self.stdout.write(self.style.WARNING(
            'iPhone: відкрийте URL → «Показати деталі» → «Відвідати цей сайт», '
            'потім /camera/ і «Старт стріму».\n'
        ))

        host = addr.strip('[]').replace(':', r'\:')
        # Відносні шляхи — інакше "D:" ламає парсер Twisted (split по ":")
        key_ep = str(key.relative_to(settings.BASE_DIR)).replace('\\', '/').replace(':', r'\:')
        cert_ep = str(cert.relative_to(settings.BASE_DIR)).replace('\\', '/').replace(':', r'\:')
        endpoints = [
            f'ssl:{int(port)}:interface={host}:privateKey={key_ep}:certKey={cert_ep}'
        ]

        if apps.is_installed('django.contrib.staticfiles') and settings.DEBUG:
            application = ASGIStaticFilesHandler(get_default_application())
        else:
            application = get_default_application()

        try:
            Server(
                application=application,
                endpoints=endpoints,
                signal_handlers=True,
                action_logger=daphne_cmd.log_action,
                http_timeout=None,
                root_path=getattr(settings, 'FORCE_SCRIPT_NAME', '') or '',
                websocket_handshake_timeout=5,
                websocket_max_message_size=daphne_cmd.websocket_max_message_size,
                websocket_max_frame_size=daphne_cmd.websocket_max_frame_size,
            ).run()
        except KeyboardInterrupt:
            pass
