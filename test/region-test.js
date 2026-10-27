const path = require('path');
const fs = require('fs');
const { OcrService } = require('../src/core/ocr');

async function main() {
  const dir = path.resolve('test/runtime');
  const ocr = new OcrService({ dir });
  await ocr.start();
  console.log('LANGS', ocr.languages, 'zh', ocr.zhLang, 'en', ocr.enLang);
  const rects = [
    { name: 'scaled', x: 675, y: 322, width: 1245, height: 105 },
    { name: 'unity', x: 450, y: 215, width: 830, height: 70 },
  ];
  for (const rect of rects) {
    const file = path.join(dir, `${rect.name}.png`);
    const res = await ocr.request({
      action: 'capture',
      ocr: true,
      image: file,
      x: rect.x,
      y: rect.y,
      w: rect.width,
      h: rect.height,
      lang: 'zh-Hans-CN',
    }, 25000);
    console.log(rect.name, 'size', res.width, res.height, 'ms', res.ms, 'text=', JSON.stringify(res.text));
    if (fs.existsSync(file)) fs.copyFileSync(file, path.resolve(`test/shots/region-${rect.name}.png`));
  }
  ocr.stop();
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
