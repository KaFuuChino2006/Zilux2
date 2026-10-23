import io
p='web/src/three/settingsBoard.ts'
s=io.open(p,encoding='utf-8').read()
anchor="  function dispose(): void {"
dbg="""  // DEV: 临时调试出口（验证完删除）
  if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__boardDebug = (): unknown => ({
      openAmount,
      scroll,
      scrollTarget,
      offsetX,
      offsetY,
      texts: [...fixedTexts, ...contentTexts].map((e) => {
        const raw = e.obj.material as unknown as { uniforms?: Record<string, { value: number }> } | null;
        const fill = raw && raw.uniforms ? raw.uniforms.uTroikaFillOpacity : undefined;
        return { text: e.obj.text, alpha: fill ? fill.value : null, hasMat: !!raw, y: e.obj.position.y, x: e.obj.position.x };
      }),
    });
  }

"""
assert anchor in s, 'anchor missing'
s=s.replace(anchor, dbg+anchor,1)
io.open(p,'w',encoding='utf-8').write(s)
print('ok')
