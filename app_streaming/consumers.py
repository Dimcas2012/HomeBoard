import json
from pathlib import Path

from asgiref.sync import sync_to_async
from channels.generic.websocket import AsyncWebsocketConsumer
from django.conf import settings

from app_cameras.models import Camera
from app_streaming import presence

_SIGNAL_LOG = Path(settings.BASE_DIR) / 'logs' / 'signal.log'


def _signal_log(line: str) -> None:
    try:
        _SIGNAL_LOG.parent.mkdir(parents=True, exist_ok=True)
        with open(_SIGNAL_LOG, 'a', encoding='utf-8') as fh:
            fh.write(line)
    except OSError:
        pass


class SignalingConsumer(AsyncWebsocketConsumer):
    """
    WebRTC signaling + presence.

    Camera:  ws/.../?role=camera&camera_id=&token=
    Viewer:  ws/.../?role=viewer  (authenticated owner)
    """

    async def connect(self):
        self.user = self.scope.get('user')
        query = dict(
            part.split('=', 1)
            for part in self.scope['query_string'].decode().split('&')
            if '=' in part
        )
        self.role = query.get('role', '')
        self.camera_id = query.get('camera_id', '')
        self.token = query.get('token', '')
        self.owner_group = None
        self.camera_group = None
        self.camera = None

        if self.role == 'viewer':
            if not self.user or not self.user.is_authenticated:
                await self.close()
                return
            self.owner_group = f'owner_{self.user.id}'
            await self.channel_layer.group_add(self.owner_group, self.channel_name)
            await self.accept()
            cameras = await self._list_cameras(self.user.id)
            await self.send(text_data=json.dumps({'type': 'camera_list', 'cameras': cameras}))
            return

        if self.role == 'camera':
            camera = await self._auth_camera(self.camera_id, self.token)
            if not camera:
                await self.close()
                return
            self.camera = camera
            self.camera_group = f'camera_{camera["id"]}'
            self.owner_group = f'owner_{camera["owner_id"]}'
            await self.channel_layer.group_add(self.camera_group, self.channel_name)
            presence.mark_live(camera['id'])
            await self._mark_online(camera['id'], True)
            await self.accept()
            await self.channel_layer.group_send(
                self.owner_group,
                {
                    'type': 'relay.message',
                    'payload': {
                        'type': 'camera_online',
                        'camera_id': camera['id'],
                        'name': camera['name'],
                    },
                },
            )
            return

        await self.close()

    async def disconnect(self, close_code):
        if self.role == 'camera' and self.camera:
            presence.mark_dead(self.camera['id'])
            await self._mark_online(self.camera['id'], False)
            if self.owner_group:
                await self.channel_layer.group_send(
                    self.owner_group,
                    {
                        'type': 'relay.message',
                        'payload': {
                            'type': 'camera_offline',
                            'camera_id': self.camera['id'],
                        },
                    },
                )
            if self.camera_group:
                await self.channel_layer.group_discard(self.camera_group, self.channel_name)
        if self.role == 'viewer' and self.owner_group:
            await self.channel_layer.group_discard(self.owner_group, self.channel_name)

    async def receive(self, text_data=None, bytes_data=None):
        if not text_data:
            return
        try:
            data = json.loads(text_data)
        except json.JSONDecodeError:
            return

        msg_type = data.get('type')

        if self.role == 'viewer':
            camera_id = data.get('camera_id')
            if not camera_id:
                return
            allowed = await self._owns_camera(self.user.id, camera_id)
            if not allowed:
                return

            # Stale DB "online" after Daphne restart: no live WS in this process.
            # Only gate new sessions; never drop mid-flight ICE/answer.
            if msg_type in ('watch', 'control') and not presence.is_live(camera_id):
                _signal_log(f'viewer {msg_type} blocked cam={camera_id} not live\n')
                await self.send(text_data=json.dumps({
                    'type': 'camera_unreachable',
                    'camera_id': camera_id,
                    'reason': 'Камера не в мережі (перезапустіть стрім на телефоні)',
                }))
                return

            if msg_type in ('watch', 'answer', 'ice', 'control'):
                _signal_log(
                    f'viewer→cam {msg_type} cam={camera_id} live={presence.is_live(camera_id)}\n'
                )

            await self.channel_layer.group_send(
                f'camera_{camera_id}',
                {
                    'type': 'relay.message',
                    'payload': {**data, 'from': 'viewer', 'viewer_channel': self.channel_name},
                },
            )
            return

        if self.role == 'camera' and self.camera:
            target = data.get('viewer_channel')
            payload = {**data, 'from': 'camera', 'camera_id': self.camera['id']}
            if msg_type in ('offer', 'answer', 'ice', 'offer_error', 'camera_state'):
                _signal_log(
                    f'cam→viewer {msg_type} cam={self.camera["id"]} target={bool(target)}\n'
                )
            if target:
                await self.channel_layer.send(
                    target,
                    {'type': 'relay.message', 'payload': payload},
                )
            elif self.owner_group:
                await self.channel_layer.group_send(
                    self.owner_group,
                    {'type': 'relay.message', 'payload': payload},
                )

    async def relay_message(self, event):
        await self.send(text_data=json.dumps(event['payload']))

    @sync_to_async
    def _auth_camera(self, camera_id, token):
        try:
            cam = Camera.objects.get(id=camera_id, device_token=token)
        except (Camera.DoesNotExist, ValueError):
            return None
        return {
            'id': str(cam.id),
            'name': cam.name,
            'owner_id': cam.owner_id,
        }

    @sync_to_async
    def _mark_online(self, camera_id, online):
        try:
            cam = Camera.objects.get(id=camera_id)
        except Camera.DoesNotExist:
            return
        if online:
            cam.mark_online()
        else:
            cam.mark_offline()

    @sync_to_async
    def _list_cameras(self, owner_id):
        qs = Camera.objects.filter(owner_id=owner_id)
        live = presence.live_ids()
        return [
            {
                'id': str(c.id),
                'name': c.name,
                'source_type': c.source_type,
                # Prefer live WS presence over possibly-stale DB flag.
                'is_online': (
                    str(c.id) in live
                    if c.source_type == Camera.SourceType.BROWSER
                    else c.is_online
                ),
                'webrtc_play_url': c.webrtc_play_url,
            }
            for c in qs
        ]

    @sync_to_async
    def _owns_camera(self, owner_id, camera_id):
        return Camera.objects.filter(owner_id=owner_id, id=camera_id).exists()
