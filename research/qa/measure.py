from PIL import Image
im = Image.open(r"E:\Zilux2开发\research\shots\iter2-row.png").convert("RGB")
w,h = im.size
px = im.load()
# thumbnails start around x=90..120; sample column band 92..118 for non-background pixels
bands=[]
prev=False
for y in range(400, 720):
    hits=0
    for x in range(92,120,2):
        r,g,b = px[x,y]
        # background is beige ~ (245,242,232); treat as content if clearly darker or saturated
        if abs(r-g)>18 or abs(g-b)>18 or r<200:
            hits+=1
    on = hits>=6
    if on and not prev: start=y
    if not on and prev: bands.append((start,y-1,y-start))
    prev=on
if prev: bands.append((start,719,720-start))
print(bands)