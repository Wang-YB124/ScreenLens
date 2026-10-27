from PIL import Image, ImageDraw, ImageFont

W, H = 1280, 760
img = Image.new("RGB", (W, H), (16, 20, 28))
d = ImageDraw.Draw(img)

msyh = "C:/Windows/Fonts/msyh.ttc"
msyh_bold = "C:/Windows/Fonts/msyhbd.ttc"
consola = "C:/Windows/Fonts/consola.ttf"


def font(path, size, index=0):
    return ImageFont.truetype(path, size, index=index)


d.text((48, 40), "ScreenLens turns any pixels into words.", font=font(msyh_bold, 34), fill=(240, 244, 255))
d.text((48, 100), "屏幕上的文字，框选一下就能翻译和解释。", font=font(msyh, 34), fill=(214, 226, 255))
d.text((48, 160), "实时字幕模式会持续识别画面中的新内容，例如视频对白或游戏提示。",
       font=font(msyh, 26), fill=(168, 188, 220))
d.text((48, 220), "The quick brown fox jumps over the lazy dog. 0123456789", font=font(consola, 24), fill=(126, 238, 202))
d.text((48, 270), "def translate(text):", font=font(consola, 24), fill=(232, 214, 160))
d.text((48, 306), "    return client.chat(text, target='zh-CN')", font=font(consola, 24), fill=(232, 214, 160))
d.text((48, 370), "Small print at 15px: button labels and captions must stay readable.", font=font(msyh, 15), fill=(150, 160, 180))
d.text((48, 410), "15px 中文小字：设置、复制、重试、翻译。", font=font(msyh, 15), fill=(150, 160, 180))
d.text((48, 470), "日本語のテキストも認識できますか？", font=font(msyh, 24), fill=(200, 210, 235))
d.text((48, 515), "Serendipity is the occurrence of events by chance in a happy way.", font=font(msyh, 24), fill=(200, 210, 235))

img.save("test/fixtures/ocr-sample.png")
print("saved test/fixtures/ocr-sample.png", img.size)
