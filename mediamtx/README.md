# MediaMTX for HomeBoard RTSP cameras

1. Download the latest Windows release from https://github.com/bluenviron/mediamtx/releases
2. Extract `mediamtx.exe` into this folder (`mediamtx/`)
3. Edit `mediamtx.yml` — set each path `source` to your camera RTSP URL
4. Run:

```powershell
cd mediamtx
.\mediamtx.exe mediamtx.yml
```

5. In HomeBoard → Камери → add IP camera with the same `path` name (e.g. `cam1`)

WebRTC play URL used by the viewer: `http://127.0.0.1:8889/<path>/whep`
