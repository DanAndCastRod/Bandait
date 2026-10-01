/**
 * nosleep.js (MIT) ships the well-known tiny WebM + MP4 clips as data URIs in
 * src/media.js (CommonJS). Only that module is used; see services/wakeLock.ts.
 */
declare module 'nosleep.js/src/media.js' {
  const media: { webm: string; mp4: string }
  export default media
}
