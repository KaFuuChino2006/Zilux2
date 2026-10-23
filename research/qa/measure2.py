from PIL import Image
im = Image.open(r"E:\Zilux2开发\research\shots\iter3-row.png").convert("RGB")
px = im.load(); w,h = im.size

def is_bg(p):
    r,g,b = p
    return r>235 and g>231 and b>218 and abs(r-g)<10 and abs(g-b)<16

# 1) recent-strip rows: scan thumb column band, group content rows
bands=[]; prev=False; start=None
for y in range(380, 660):
    hits=sum(1 for x in range(92,120,2) if not is_bg(px[x,y]))
    on = hits>=6
    if on and not prev: start=y
    if not on and prev: bands.append((start,y-1))
    prev=on
print("thumb bands:", bands)

# 2) card bounds: scan row y=400 for non-background columns (card is near-white)
ys=400
col_on=[]
for x in range(640, 1600):
    r,g,b = px[x,ys]
    col_on.append((x, r,g,b))
# card is white-ish (r>248) vs bg beige (245,242,232): detect blue channel higher than bg
card_cols=[x for x,r,g,b in col_on if b>238 and r>246]
print("card x range at y=400:", (min(card_cols), max(card_cols)) if card_cols else None)

# 3) vertical bounds of card: scan column x=700 down for white-ish
col=[y for y in range(350, 700) if (lambda p: p[2]>238 and p[0]>246)(px[700,y])]
print("card y range at x=700:", (min(col), max(col)) if col else None)