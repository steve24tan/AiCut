// Stand-in for yt-dlp in tests: honours -P, -x and the URL after "--"; behaviour is chosen by words in the URL.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2), folder = args[args.indexOf('-P') + 1], url = args[args.indexOf('--') + 1], audio = args.includes('-x');
if (url.includes('fail')) { console.error('[youtube] abc: Downloading webpage\nERROR: [youtube] abc: Video unavailable'); process.exit(1); }
console.log('AICUT_PROGRESS  12.5%');
if (url.includes('slow')) setTimeout(() => {}, 60000);
else {
  const file = join(url.includes('escape') ? join(folder, '..', '..', '..') : folder, audio ? 'abc123.mp3' : (url.includes('webm') ? 'abc123.mkv' : 'abc123.mp4'));
  writeFileSync(file, audio ? 'ID3 fake mp3' : 'fake mp4 bytes');
  console.log('AICUT_PROGRESS 100.0%');
  console.log('AICUT_DONE ' + JSON.stringify({ filepath: file, title: '测试视频: A/B', uploader: 'Some Channel', webpage_url: url, duration: 12, extractor_key: 'Youtube' }));
}
