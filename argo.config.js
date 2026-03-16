export default {
  baseURL: process.env.BASE_URL || 'https://news.ycombinator.com',
  demosDir: 'demos/',
  outputDir: 'videos/',
  video: {
    width: 1920,
    height: 1080,
    fps: 30,
    browser: 'webkit',
    // For flagship showcase / landing-page exports on a 5K display, switch to:
    // width: 3840,
    // height: 2160,
    // deviceScaleFactor: 1,
  },
  export: { thumbnailPath: 'assets/logo-thumb.png' },
};
