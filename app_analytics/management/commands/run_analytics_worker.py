from django.core.management.base import BaseCommand
from django.db import close_old_connections
from django.utils import timezone

from app_analytics.services import claim_next_job, cleanup_old_frames, process_job


class Command(BaseCommand):
    help = 'Run HomeBoard AI analytics worker (YOLO CPU).'

    def add_arguments(self, parser):
        parser.add_argument('--once', action='store_true', help='Process one job and exit')
        parser.add_argument('--sleep', type=float, default=0.4, help='Idle sleep seconds')

    def handle(self, *args, **options):
        self.stdout.write(self.style.SUCCESS('analytics worker started'))
        # Warm model
        try:
            from app_analytics.inference import get_model
            get_model()
            self.stdout.write(self.style.SUCCESS('YOLO model ready'))
        except Exception as exc:
            self.stderr.write(self.style.WARNING(f'YOLO not loaded yet: {exc}'))

        last_cleanup = timezone.now()
        last_rtsp = timezone.now()
        while True:
            close_old_connections()
            job = None
            try:
                job = claim_next_job()
                if job:
                    process_job(job)
                    if options['once']:
                        return
                    continue
            except Exception as exc:
                self.stderr.write(f'worker error: {exc}')
            if options['once']:
                self.stdout.write('no pending jobs')
                return
            if (timezone.now() - last_rtsp).total_seconds() > 2.0:
                try:
                    from app_analytics.rtsp_grab import enqueue_rtsp_cameras
                    enqueue_rtsp_cameras()
                except Exception as exc:
                    self.stderr.write(f'rtsp enqueue: {exc}')
                last_rtsp = timezone.now()
            if (timezone.now() - last_cleanup).total_seconds() > 3600:
                try:
                    cleanup_old_frames(24)
                except Exception:
                    pass
                last_cleanup = timezone.now()
            import time
            time.sleep(float(options['sleep']))
