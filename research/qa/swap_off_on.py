import io, re, sys

path = r'E:\Zilux2开发\web\src\ui\spaceShell.ts'
src = io.open(path, encoding='utf-8').read()
lines = src.split('\n')

swapped = 0
i = 0
while i < len(lines) - 1:
    a, b = lines[i], lines[i + 1]
    if (
        'custom-seg-btn' in a and '>开</button>' in a
        and 'custom-seg-btn' in b and '>关</button>' in b
        and 'data-' in a and 'data-' in b
    ):
        lines[i], lines[i + 1] = b, a
        swapped += 1
        i += 2
        continue
    i += 1

if swapped == 0:
    print('no pairs found')
    sys.exit(1)

io.open(path, 'w', encoding='utf-8', newline='\n').write('\n'.join(lines))
print(f'swapped {swapped} pairs')
