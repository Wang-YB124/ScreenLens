from PIL import Image, ImageDraw, ImageFilter
import math

S = 1024
SUP = 2
W = S * SUP
img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# Background rounded square with vertical gradient
bg = Image.new("RGBA", (W, W), (0, 0, 0, 0))
bgd = ImageDraw.Draw(bg)
for y in range(W):
    t = y / (W - 1)
    top = (20, 28, 43)
    bottom = (7, 10, 15)
    color = tuple(int(top[i] * (1 - t) + bottom[i] * t) for i in range(3))
    bgd.line([(0, y), (W, y)], fill=color + (255,))
mask = Image.new("L", (W, W), 0)
ImageDraw.Draw(mask).rounded_rectangle([48, 48, W - 48, W - 48], radius=230, fill=255)
img.paste(bg, (0, 0), mask)

# Soft ambient glows
glow = Image.new("RGBA", (W, W), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
gd.ellipse([150, 60, 760, 670], fill=(139, 243, 208, 42))
gd.ellipse([430, 380, 1000, 950], fill=(155, 140, 255, 46))
glow = glow.filter(ImageFilter.GaussianBlur(120))
img.alpha_composite(Image.composite(glow, Image.new("RGBA", (W, W), (0, 0, 0, 0)), mask))

# Lens ring with diagonal gradient
cx, cy = W // 2, W // 2 - 20
r_out = 300
ring_w = 54
grad = Image.new("RGBA", (W, W), (0, 0, 0, 0))
gdr = ImageDraw.Draw(grad)
mint = (139, 243, 208)
iris = (155, 140, 255)
for y in range(W):
    for_x = y  # diagonal parameter
    t = min(1.0, max(0.0, (y) / (W - 1)))
    color = tuple(int(mint[i] * (1 - t) + iris[i] * t) for i in range(3))
    gdr.line([(0, y), (W, y)], fill=color + (255,))
ring_mask = Image.new("L", (W, W), 0)
rm = ImageDraw.Draw(ring_mask)
rm.ellipse([cx - r_out, cy - r_out, cx + r_out, cy + r_out], fill=255)
rm.ellipse([cx - r_out + ring_w, cy - r_out + ring_w, cx + r_out - ring_w, cy + r_out - ring_w], fill=0)
img.paste(grad, (0, 0), ring_mask)

# Inner glass
inner = Image.new("RGBA", (W, W), (0, 0, 0, 0))
idr = ImageDraw.Draw(inner)
idr.ellipse(
    [cx - r_out + ring_w + 10, cy - r_out + ring_w + 10, cx + r_out - ring_w - 10, cy + r_out - ring_w - 10],
    fill=(255, 255, 255, 10),
)
inner = inner.filter(ImageFilter.GaussianBlur(2))
img.alpha_composite(inner)

# Text lines inside the lens
line_color = (235, 244, 255, 220)
accent = (139, 243, 208, 255)
for i, (w, alpha, color) in enumerate([(250, 215, line_color), (320, 190, line_color), (190, 150, line_color)]):
    y = cy - 82 + i * 82
    layer = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    ld.rounded_rectangle([cx - 165, y, cx - 165 + w, y + 26], radius=13, fill=color)
    img.alpha_composite(layer)

# Accent bar under the lines
bar = Image.new("RGBA", (W, W), (0, 0, 0, 0))
bd = ImageDraw.Draw(bar)
bd.rounded_rectangle([cx - 165, cy + 110, cx + 76, cy + 136], radius=13, fill=accent)
img.alpha_composite(bar)

# Highlight arc on the ring
arc = Image.new("RGBA", (W, W), (0, 0, 0, 0))
ad = ImageDraw.Draw(arc)
ad.arc(
    [cx - r_out + ring_w / 2, cy - r_out + ring_w / 2, cx + r_out - ring_w / 2, cy + r_out - ring_w / 2],
    start=200,
    end=285,
    fill=(255, 255, 255, 130),
    width=16,
)
arc = arc.filter(ImageFilter.GaussianBlur(2))
img.alpha_composite(arc)

# Sparkle at upper right
spark = Image.new("RGBA", (W, W), (0, 0, 0, 0))
sd = ImageDraw.Draw(spark)
sx, sy = cx + 250, cy - 268
pts = [(sx, sy - 46), (sx + 12, sy - 12), (sx + 46, sy), (sx + 12, sy + 12), (sx, sy + 46), (sx - 12, sy + 12), (sx - 46, sy), (sx - 12, sy - 12)]
sd.polygon(pts, fill=(255, 255, 255, 235))
spark = spark.filter(ImageFilter.GaussianBlur(0.6))
img.alpha_composite(spark)

# Frame border
border = Image.new("RGBA", (W, W), (0, 0, 0, 0))
brd = ImageDraw.Draw(border)
brd.rounded_rectangle([48, 48, W - 48, W - 48], radius=230, outline=(255, 255, 255, 26), width=3)
img.alpha_composite(border)

img = img.resize((S, S), Image.LANCZOS)
img.save("assets/icon.png")
img.resize((256, 256), Image.LANCZOS).save("assets/icon-256.png")
img.resize((64, 64), Image.LANCZOS).save("assets/tray.png")
img.resize((32, 32), Image.LANCZOS).save("assets/tray-16.png")
ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
img.save("assets/icon.ico", sizes=ico_sizes)
print("icons written")
