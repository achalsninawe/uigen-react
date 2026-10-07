/**
 * Records this browser tab to a video file.
 *
 * The browser asks the person to share the tab — a prompt no page can skip —
 * and from then on everything drawn in it is captured, the demo's cursor and
 * captions included. MP4 where the browser can write it, so the file plays
 * anywhere; WebM otherwise.
 */

const TYPES = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']

export interface Recording {
  url: string
  blob: Blob
  extension: 'mp4' | 'webm'
  seconds: number
}

export interface TabRecorder {
  /** Stops capturing and resolves with the finished video. */
  finish: () => Promise<Recording>
  /** Fires if the person ends sharing from the browser's own bar. */
  onEnded: (handler: () => void) => void
}

export function canRecord(): boolean {
  return typeof MediaRecorder !== 'undefined' && Boolean(navigator.mediaDevices?.getDisplayMedia)
}

export async function recordThisTab(): Promise<TabRecorder> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    // The window at its real size; left to itself the capture can come back much smaller.
    video: {
      frameRate: 30,
      width: { ideal: Math.round(window.innerWidth * window.devicePixelRatio) },
      height: { ideal: Math.round(window.innerHeight * window.devicePixelRatio) },
    },
    audio: false,
    // Chrome: offer this tab first and keep the person from wandering off it.
    preferCurrentTab: true,
    selfBrowserSurface: 'include',
    surfaceSwitching: 'exclude',
  } as DisplayMediaStreamOptions)

  const mimeType = TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? ''
  const frames = await evenFrames(stream)
  const recorder = new MediaRecorder(frames.stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: 6_000_000 })
  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }
  const started = Date.now()
  recorder.start(1000)

  let ended: (() => void) | undefined
  stream.getVideoTracks()[0]?.addEventListener('ended', () => ended?.())

  return {
    onEnded: (handler) => {
      ended = handler
    },
    finish: () =>
      new Promise<Recording>((resolve) => {
        const done = () => {
          frames.stop()
          stream.getTracks().forEach((t) => t.stop())
          const type = recorder.mimeType || mimeType || 'video/webm'
          const blob = new Blob(chunks, { type })
          resolve({
            blob,
            url: URL.createObjectURL(blob),
            extension: type.includes('mp4') ? 'mp4' : 'webm',
            seconds: Math.round((Date.now() - started) / 1000),
          })
        }
        if (recorder.state === 'inactive') return done()
        recorder.onstop = done
        recorder.stop()
      }),
  }
}

/**
 * The captured tab, redrawn at a size the encoder can take whole.
 *
 * H.264 encodes in 16-pixel blocks. A window whose height is not a multiple of
 * 16 leaves the encoder padding the last row, and Chrome's MP4 writer fills
 * that padding with green — a band along the bottom of every frame. Drawing
 * each frame onto a canvas trimmed to a multiple of 16 leaves nothing to pad.
 */
async function evenFrames(source: MediaStream): Promise<{ stream: MediaStream; stop: () => void }> {
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.srcObject = source
  await video.play()
  if (!video.videoWidth) await new Promise((r) => video.addEventListener('loadedmetadata', r, { once: true }))

  const canvas = document.createElement('canvas')
  canvas.width = Math.max(16, Math.floor(video.videoWidth / 16) * 16)
  canvas.height = Math.max(16, Math.floor(video.videoHeight / 16) * 16)
  const context = canvas.getContext('2d')!

  // The whole frame, scaled to the canvas: at most a few pixels' squeeze, and a capture that
  // changes size mid-recording is still drawn whole rather than cropped or repeated.
  const draw = () => {
    if (video.videoWidth && video.videoHeight) context.drawImage(video, 0, 0, canvas.width, canvas.height)
  }
  draw()
  const timer = window.setInterval(draw, 1000 / 30)

  return {
    stream: canvas.captureStream(30),
    stop: () => {
      window.clearInterval(timer)
      video.srcObject = null
    },
  }
}
