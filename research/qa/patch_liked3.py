# -*- coding: utf-8 -*-
"""v1.12b：修正 liked 视图歌曲条文字方向（相机 270° 俯视时 180° 倒置）+ 隐藏小玻璃投影。"""
import io
import shutil

p = r'E:\Zilux2开发\web\src\three\loginSpace.ts'
shutil.copyfile(p, p + '.bak-v12b')
s = io.open(p, 'r', encoding='utf-8', newline='').read()


def rep(old, new):
    global s
    assert s.count(old) == 1, ('anchor', old[:60], s.count(old))
    s = s.replace(old, new, 1)


# 1) 文字方向：canvas 内容整体旋转 180°，抵消 270° 相机下纹理 v/u 同时反向
rep(
    """    ctx.clearRect(0, 0, W, H);
    ctx.save();
    spaceRoundRect(ctx, 0, 0, W, H, H * 0.22);""",
    """    ctx.clearRect(0, 0, W, H);
    // 相机 yaw=270° 俯视时，平面 UV 会让文字整体倒置，这里把绘制内容转 180° 抵消
    ctx.save();
    ctx.translate(W, H);
    ctx.rotate(Math.PI);
    ctx.save();
    spaceRoundRect(ctx, 0, 0, W, H, H * 0.22);""",
)
rep(
    """    }
    ctx.restore();
    row.texture.needsUpdate = true;
  };""",
    """    }
    ctx.restore();
    ctx.restore();
    row.texture.needsUpdate = true;
  };""",
)

# 2) 小玻璃投影随 chips 一起隐藏
rep(
    """  const setChipsVisible = (visible: boolean): void => {
    chips.forEach((chip) => {
      chip.group.visible = visible;
    });
  };""",
    """  const setChipsVisible = (visible: boolean): void => {
    chips.forEach((chip) => {
      chip.group.visible = visible;
    });
    chipShadows.forEach((shadow) => {
      shadow.visible = visible;
    });
  };""",
)
rep(
    """  const chipShadowGeo = new THREE.ShapeGeometry(chipShadowShape, 12);""",
    """  const chipShadows: THREE.Mesh[] = [];
  const chipShadowGeo = new THREE.ShapeGeometry(chipShadowShape, 12);""",
)
rep(
    """    shadow.renderOrder = 4;
    spaceGroup.add(shadow);
  });""",
    """    shadow.renderOrder = 4;
    spaceGroup.add(shadow);
    chipShadows.push(shadow);
  });""",
)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('liked text + chip shadows fixed')
