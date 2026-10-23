import io

path = r"E:\Zilux2开发\web\src\three\loginSpace.ts"
src = io.open(path, encoding="utf-8").read()


def replace_once(old, new, label):
    global src
    assert src.count(old) == 1, (label, src.count(old))
    src = src.replace(old, new, 1)


# ---------- A. 交互段 ----------
a_start = "  /* ------------------------------ 交互 ------------------------------ */"
a_end = "  canvas.addEventListener('pointerup', onPointerUp);"
i = src.find(a_start)
j = src.find(a_end)
assert i != -1 and j != -1 and i < j
new_a = r'''  /* ------------------------------ 交互：登录点选 + 空间视角 ------------------------------ */

  const clamp = (value: number, min: number, max: number): number =>
    Math.min(max, Math.max(min, value));

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2(999, 999);
  let hoveredSource: Source | null = null;
  let pointerDown: { x: number; y: number; time: number } | null = null;
  const cameraParallax = new THREE.Vector2(0, 0);
  const loginCam = new THREE.Vector2(0, 0.18);
  let enteredTarget = false;
  let enterAmount = 0;

  // 空间视角：默认从上往下看玻璃地面；拖动旋转、滚轮缩放
  const view = { yaw: 0, pitch: 0.3, radius: 8.8 };
  const viewTarget = { yaw: 0, pitch: 0.3, radius: 8.8 };
  let orbitDragging = false;
  let orbitLast: { x: number; y: number } | null = null;
  let yawVelocity = 0;
  let pitchVelocity = 0;

  const updatePointer = (event: PointerEvent): void => {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    cameraParallax.set(pointer.x, pointer.y);
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (orbitDragging && orbitLast && enterAmount > 0.4) {
      const dx = event.clientX - orbitLast.x;
      const dy = event.clientY - orbitLast.y;
      orbitLast = { x: event.clientX, y: event.clientY };
      viewTarget.yaw -= dx * 0.0055;
      viewTarget.pitch = clamp(viewTarget.pitch + dy * 0.0042, 0.08, 1.22);
      yawVelocity = -dx * 0.0055 * 0.6;
      pitchVelocity = dy * 0.0042 * 0.6;
      canvas.style.cursor = 'grabbing';
      return;
    }
    updatePointer(event);
    if (enteredTarget) {
      canvas.style.cursor = 'grab';
      return;
    }
    canvas.style.cursor = hoveredSource ? 'pointer' : 'default';
  };

  const onPointerLeave = (): void => {
    pointer.set(999, 999);
    cameraParallax.set(0, 0);
    if (!enteredTarget) canvas.style.cursor = 'default';
  };

  const onPointerDown = (event: PointerEvent): void => {
    pointerDown = { x: event.clientX, y: event.clientY, time: performance.now() };
    if (enterAmount > 0.4) {
      orbitDragging = true;
      orbitLast = { x: event.clientX, y: event.clientY };
      yawVelocity = 0;
      pitchVelocity = 0;
      if (canvas.setPointerCapture) canvas.setPointerCapture(event.pointerId);
      canvas.style.cursor = 'grabbing';
    }
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (orbitDragging) {
      orbitDragging = false;
      orbitLast = null;
      if (canvas.hasPointerCapture && canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      canvas.style.cursor = 'grab';
      pointerDown = null;
      return;
    }
    const down = pointerDown;
    pointerDown = null;
    if (!down || enteredTarget) return;
    const dx = event.clientX - down.x;
    const dy = event.clientY - down.y;
    if (Math.hypot(dx, dy) > 8 || performance.now() - down.time > 700) return;
    if (hoveredSource) options.onSelect(hoveredSource);
  };

  const onPointerCancel = (): void => {
    orbitDragging = false;
    orbitLast = null;
    pointerDown = null;
  };

  const onWheel = (event: WheelEvent): void => {
    if (enterAmount < 0.4) return;
    event.preventDefault();
    viewTarget.radius = clamp(viewTarget.radius + event.deltaY * 0.0018, 5.2, 13.5);
  };

  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('wheel', onWheel, { passive: false });
'''
src = src[:i] + new_a + src[j + len(a_end):]

# ---------- B. frame 相机 + 空间显现 ----------
b_start = "    const camTargetX = cameraParallax.x * 0.16;"
b_end = "    const loginOpacity = 1 - Math.min(1, enterAmount / 0.45);"
i = src.find(b_start)
j = src.find(b_end)
assert i != -1 and j != -1 and i < j
new_b = r'''    // 登录视角视差
    loginCam.x += (cameraParallax.x * 0.16 - loginCam.x) * Math.min(1, delta * 3.2);
    loginCam.y += (0.18 + cameraParallax.y * 0.1 - loginCam.y) * Math.min(1, delta * 3.2);

    // 空间视角：惯性 + 平滑
    if (!orbitDragging) {
      viewTarget.yaw += yawVelocity;
      viewTarget.pitch = clamp(viewTarget.pitch + pitchVelocity, 0.08, 1.22);
      yawVelocity *= 0.93;
      pitchVelocity *= 0.93;
    }
    const viewSmooth = Math.min(1, delta * 7.5);
    view.yaw += (viewTarget.yaw - view.yaw) * viewSmooth;
    view.pitch += (viewTarget.pitch - view.pitch) * viewSmooth;
    view.radius += (viewTarget.radius - view.radius) * viewSmooth;

    const enterTarget = enteredTarget ? 1 : 0;
    enterAmount += (enterTarget - enterAmount) * Math.min(1, delta * 4.4);
    if (enterAmount < 0.0015) enterAmount = 0;
    if (enterAmount > 0.9985) enterAmount = 1;
    const enterEase = enterAmount * enterAmount * (3 - 2 * enterAmount);

    // 相机：登录正视图 → 环绕玻璃地面中心的俯视视角
    const sinPitch = Math.sin(view.pitch);
    const cosPitch = Math.cos(view.pitch);
    const orbitX = groundCenter.x + Math.sin(view.yaw) * sinPitch * view.radius;
    const orbitY = groundCenter.y + cosPitch * view.radius;
    const orbitZ = groundCenter.z + Math.cos(view.yaw) * sinPitch * view.radius;
    camera.position.set(
      loginCam.x + (orbitX - loginCam.x) * enterEase,
      loginCam.y + (orbitY - loginCam.y) * enterEase,
      baseCameraZ + (orbitZ - baseCameraZ) * enterEase,
    );
    camera.lookAt(
      groundCenter.x * enterEase,
      0.1 + (groundCenter.y - 0.1) * enterEase,
      groundCenter.z * enterEase,
    );

    // 玻璃地面：从下方升起 + 淡入
    const spaceAlpha = enterAmount <= 0.3 ? 0 : Math.min(1, (enterAmount - 0.3) / 0.5);
    const spaceVisible = spaceAlpha > 0.002;
    spaceGroup.visible = spaceVisible;
    if (spaceVisible) {
      spaceMats.forEach((material, matIndex) => {
        material.opacity = spaceAlpha * (spaceOpacity[matIndex] ?? 1);
      });
      spaceGroup.position.y = GROUND_Y + (1 - enterAmount) * -2.6;
      spaceGroup.position.z = (1 - enterAmount) * 1.6;
    }

'''
src = src[:i] + new_b + src[j:]

# ---------- C. setEntered 视角重置 ----------
replace_once(
    """  const setEntered = (entered: boolean, instant = false): void => {
    enteredTarget = entered;
    if (instant) enterAmount = entered ? 1 : 0;
    if (entered) {
      pointer.set(999, 999);
      cameraParallax.set(0, 0);
      hoveredSource = null;
      canvas.style.cursor = 'default';
    }
  };""",
    """  const setEntered = (entered: boolean, instant = false): void => {
    enteredTarget = entered;
    if (instant) enterAmount = entered ? 1 : 0;
    if (entered) {
      pointer.set(999, 999);
      cameraParallax.set(0, 0);
      hoveredSource = null;
      viewTarget.yaw = 0;
      viewTarget.pitch = 0.3;
      viewTarget.radius = 8.8;
      yawVelocity = 0;
      pitchVelocity = 0;
      if (instant) {
        view.yaw = viewTarget.yaw;
        view.pitch = viewTarget.pitch;
        view.radius = viewTarget.radius;
      }
      canvas.style.cursor = 'grab';
    } else {
      orbitDragging = false;
      orbitLast = null;
      canvas.style.cursor = 'default';
    }
  };

  const setView = (pitch: number, yaw: number, radius: number, instant = true): void => {
    viewTarget.pitch = clamp(pitch, 0.08, 1.22);
    viewTarget.yaw = yaw;
    viewTarget.radius = clamp(radius, 5.2, 13.5);
    if (instant) {
      view.pitch = viewTarget.pitch;
      view.yaw = viewTarget.yaw;
      view.radius = viewTarget.radius;
    }
  };""",
    "setEntered",
)

# ---------- D. handle 接口增加 setView ----------
replace_once(
    """export interface LoginSpaceHandle {
  setFace(source: 'netease' | 'qq', face: LoginCardFace): void;
  setEntered(entered: boolean, instant?: boolean): void;
  start(): void;
  stop(): void;
  resize(): void;
  dispose(): void;
}""",
    """export interface LoginSpaceHandle {
  setFace(source: 'netease' | 'qq', face: LoginCardFace): void;
  setEntered(entered: boolean, instant?: boolean): void;
  setView(pitch: number, yaw: number, radius: number, instant?: boolean): void;
  start(): void;
  stop(): void;
  resize(): void;
  dispose(): void;
}""",
    "LoginSpaceHandle",
)

# ---------- E. dispose 事件与资源 ----------
replace_once(
    """    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerleave', onPointerLeave);
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('resize', onWindowResize);""",
    """    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerleave', onPointerLeave);
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerCancel);
    canvas.removeEventListener('wheel', onWheel);
    window.removeEventListener('resize', onWindowResize);""",
    "dispose listeners",
)

replace_once(
    """    hallMats.forEach((material) => material.dispose());
    hallGeometries.forEach((geometry) => geometry.dispose());
    hallTextures.forEach((texture) => texture.dispose());""",
    """    spaceMats.forEach((material) => material.dispose());
    spaceGeometries.forEach((geometry) => geometry.dispose());
    spaceTextures.forEach((texture) => texture.dispose());
    groundMask.dispose();""",
    "dispose space resources",
)

# ---------- F. return handle 增加 setView ----------
replace_once(
    "  return { setFace, setEntered, start, stop, resize, dispose };",
    "  return { setFace, setEntered, setView, start, stop, resize, dispose };",
    "return handle",
)

io.open(path, "w", encoding="utf-8", newline="\n").write(src)
print("edits applied; new length", len(src))
