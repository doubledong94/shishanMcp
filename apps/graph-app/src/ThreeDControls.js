// 忠实移植旧项目 scene_viewer 的 ThreeDControls.cpp（threepp 自带的三维相机控制）到 JS。
// 与 three.js 的 OrbitControls 不同：状态机 ROTATE/DOLLY/PAN/ROTATEZ、每帧 update() 应用
// 带 dampingFactor 的 rotateDelta、中键做绕 Z 滚转(ROTATEZ)、方向按旧项目按键映射。
import * as THREE from "three";

const State = Object.freeze({ NONE: 0, ROTATE: 1, DOLLY: 2, PAN: 3, ROTATEZ: 4 });

export class ThreeDControls {
  constructor(camera, domElement) {
    this.camera = camera;
    this.domElement = domElement;
    this.target = new THREE.Vector3();
    this.enabled = true;
    this.enableDamping = true;
    this.dampingFactor = 0.001;
    this.enableZoom = true;
    this.zoomSpeed = 1.0;
    this.enableRotate = true;
    this.rotateSpeed = 1.0;
    this.enablePan = true;
    this.panSpeed = 1.0;
    this.screenSpacePanning = true;
    this.keyPanSpeed = 7;
    this.enableKeys = true;
    this.dragging = false;
    this.minZoom = 0;
    this.maxZoom = Infinity;

    this.state = State.NONE;
    this.scale = 1;
    this.panOffset = new THREE.Vector3();
    this.rotateStart = new THREE.Vector2();
    this.rotateEnd = new THREE.Vector2();
    this.rotateDelta = new THREE.Vector2();
    this.rotateZStart = new THREE.Vector2();
    this.rotateZEnd = new THREE.Vector2();
    this.rotateZDelta = new THREE.Vector2();
    this.panStart = new THREE.Vector2();
    this.panEnd = new THREE.Vector2();
    this.panDelta = new THREE.Vector2();
    this.dollyStart = new THREE.Vector2();
    this.dollyEnd = new THREE.Vector2();
    this.dollyDelta = new THREE.Vector2();

    // 触屏多指跟踪：pointerId -> 最近位置(dom 坐标)。单指=旋转，双指=捏合缩放。
    this._pointers = new Map();
    this.pinchDist = 0; // 两指上一次距离

    this._onPointerDown = (e) => this._pointerDown(e);
    this._onPointerMove = (e) => this._pointerMove(e);
    this._onPointerUp = (e) => this._pointerUp(e);
    this._onWheel = (e) => this._mouseWheel(e);
    this._onKeyDown = (e) => this._keyDown(e);
    domElement.addEventListener("pointerdown", this._onPointerDown);
    domElement.addEventListener("pointermove", this._onPointerMove);
    domElement.addEventListener("pointerup", this._onPointerUp);
    domElement.addEventListener("wheel", this._onWheel, { passive: false });
    window.addEventListener("keydown", this._onKeyDown);

    this.update();
  }

  dispose() {
    const el = this.domElement;
    el.removeEventListener("pointerdown", this._onPointerDown);
    el.removeEventListener("pointermove", this._onPointerMove);
    el.removeEventListener("pointerup", this._onPointerUp);
    el.removeEventListener("wheel", this._onWheel);
    window.removeEventListener("keydown", this._onKeyDown);
    this._pointers.clear();
    this.dragging = false;
    this.state = State.NONE;
  }

  getZoomScale() { return Math.pow(0.95, this.zoomSpeed); }

  _posOf(e) {
    const r = this.domElement.getBoundingClientRect();
    return new THREE.Vector2(e.clientX - r.left, e.clientY - r.top);
  }

  // C++ button：0=LEFT, 1=RIGHT, 2=MIDDLE；JS PointerEvent button：0=左,1=中,2=右
  _mapButton(b) {
    if (b === 0) return 0;       // LEFT
    if (b === 1) return 2;       // MIDDLE -> ROTATEZ
    if (b === 2) return 1;       // RIGHT  -> PAN
    return -1;
  }

  // ---------- 触屏多指（单指旋转 / 双指捏合缩放） ----------
  _pointerDown(e) {
    if (!this.enabled) return;
    const pos = this._posOf(e);
    if (e.pointerType === "touch") {
      this._pointers.set(e.pointerId, pos.clone());
      try { this.domElement.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      if (this._pointers.size === 1) {
        if (this.enableRotate) { this._downRotate(pos); this.state = State.ROTATE; this.dragging = true; }
      } else if (this._pointers.size === 2) {
        // 双指 → 捏合缩放。清掉单指旋转累积，避免切手势时跳变。
        this.state = this.enableZoom ? State.DOLLY : State.NONE;
        this.dragging = this.state !== State.NONE;
        this.rotateDelta.set(0, 0);
        this.rotateZDelta.set(0, 0);
        this._resetPinch();
      }
      return;
    }
    this._mouseDown(e);
  }

  _pointerMove(e) {
    if (!this.enabled) return;
    const pos = this._posOf(e);
    if (e.pointerType === "touch") {
      if (!this._pointers.has(e.pointerId)) return;
      this._pointers.set(e.pointerId, pos.clone());
      if (this._pointers.size >= 2) {
        if (this.state === State.DOLLY) this._pinch();
      } else if (this.state === State.ROTATE) {
        this._moveRotate(pos);
      }
      return;
    }
    this._mouseMove(e);
  }

  _pointerUp(e) {
    if (e.pointerType === "touch") {
      this._pointers.delete(e.pointerId);
      if (this._pointers.size === 0) {
        this.state = State.NONE;
        this.dragging = false;
      } else if (this._pointers.size === 1) {
        // 抬到只剩一指 → 恢复单指旋转（起点取该指当前位置）
        const left = this._pointers.entries().next().value;
        if (left) this._downRotate(left[1]);
        this._resetPinch();
        this.state = this.enableRotate ? State.ROTATE : State.NONE;
        this.dragging = this.state !== State.NONE;
      }
      return;
    }
    this._mouseUp(e);
  }

  _twoFingerDistance() {
    const pts = [...this._pointers.values()];
    if (pts.length < 2) return 0;
    return pts[0].distanceTo(pts[1]);
  }

  _resetPinch() { this.pinchDist = this._twoFingerDistance(); }

  _pinch() {
    const d = this._twoFingerDistance();
    if (d <= 0) return;
    if (this.pinchDist <= 0) { this.pinchDist = d; return; }
    const ratio = d / this.pinchDist; // >1 = 双指张开(放大)，<1 = 并拢(缩小)
    if (ratio !== 1) this._dollyBy(ratio);
    this.pinchDist = d;
    if (!this.enableDamping) this.update();
  }

  _dollyBy(ratio) {
    if (this.camera.isPerspectiveCamera) {
      this.scale /= ratio; // ratio>1 → 相机靠近 → 放大；<1 → 远离 → 缩小
    } else if (this.camera.isOrthographicCamera) {
      this.camera.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.camera.zoom * ratio));
      this.camera.updateProjectionMatrix();
    }
  }

  _mouseDown(e) {
    if (!this.enabled) return;
    const btn = this._mapButton(e.button);
    if (btn < 0) return;
    const pos = this._posOf(e);
    this.dragging = true;
    switch (btn) {
      case 0:
        if (this.enableRotate) { this._downRotate(pos); this.state = State.ROTATE; }
        break;
      case 1:
        if (this.enablePan) { this._downRotate(pos); this._downPan(pos); this.state = State.PAN; }
        break;
      case 2:
        if (this.enableZoom) { this._downRotateZ(pos); this.state = State.ROTATEZ; }
        break;
    }
    if (this.state !== State.NONE) {
      try { this.domElement.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    }
  }

  _mouseMove(e) {
    if (!this.enabled) return;
    const pos = this._posOf(e);
    switch (this.state) {
      case State.ROTATE: if (this.enableRotate) this._moveRotate(pos); break;
      case State.ROTATEZ: this._moveRotateZ(pos); break;
      case State.PAN: if (this.enablePan) this._movePan(pos); break;
      case State.DOLLY: if (this.enableZoom) this._moveDolly(pos); break;
    }
  }

  _mouseUp() { this.state = State.NONE; this.dragging = false; }

  _mouseWheel(e) {
    if (!this.enabled || !this.enableZoom) return;
    if (this.state !== State.NONE && this.state !== State.ROTATE) return;
    e.preventDefault();
    if (e.deltaY < 0) this._dollyIn(this.getZoomScale());
    else if (e.deltaY > 0) this._dollyOut(this.getZoomScale());
    if (!this.enableDamping) this.update();
  }

  _keyDown(e) {
    if (!this.enabled || !this.enableKeys || !this.enablePan) return;
    let handled = true;
    switch (e.key) {
      case "ArrowUp": this._pan(0, this.keyPanSpeed); break;
      case "ArrowDown": this._pan(0, -this.keyPanSpeed); break;
      case "ArrowLeft": this._pan(this.keyPanSpeed, 0); break;
      case "ArrowRight": this._pan(-this.keyPanSpeed, 0); break;
      default: handled = false;
    }
    if (handled && !this.enableDamping) this.update();
  }

  _downRotate(p) { this.rotateStart.copy(p); }
  _downRotateZ(p) { this.rotateZStart.copy(p); }
  _downDolly(p) { this.dollyStart.copy(p); }
  _downPan(p) { this.panStart.copy(p); }

  _moveRotate(p) {
    this.rotateEnd.copy(p);
    this.rotateDelta.subVectors(this.rotateEnd, this.rotateStart).multiplyScalar(this.rotateSpeed);
    const h = this.domElement.clientHeight || 1;
    this.rotateDelta.multiplyScalar(30 / h);
    this.rotateStart.copy(this.rotateEnd);
    if (!this.enableDamping) this.update();
  }

  _moveRotateZ(p) {
    this.rotateZEnd.copy(p);
    this.rotateZDelta.subVectors(this.rotateZEnd, this.rotateZStart).multiplyScalar(this.rotateSpeed);
    const h = this.domElement.clientHeight || 1;
    this.rotateZDelta.multiplyScalar(30 / h);
    this.rotateZStart.copy(this.rotateZEnd);
    if (!this.enableDamping) this.update();
  }

  _moveDolly(p) {
    this.dollyEnd.copy(p);
    this.dollyDelta.subVectors(this.dollyEnd, this.dollyStart);
    if (this.dollyDelta.y > 0) this._dollyIn(this.getZoomScale());
    else if (this.dollyDelta.y < 0) this._dollyOut(this.getZoomScale());
    this.dollyStart.copy(this.dollyEnd);
    if (!this.enableDamping) this.update();
  }

  _movePan(p) {
    this.panEnd.copy(p);
    this.panDelta.subVectors(this.panEnd, this.panStart).multiplyScalar(this.panSpeed);
    this._pan(this.panDelta.x, this.panDelta.y);
    this.panStart.copy(this.panEnd);
    if (!this.enableDamping) this.update();
  }

  _dollyIn(d) {
    if (this.camera.isPerspectiveCamera) this.scale /= d;
    else if (this.camera.isOrthographicCamera) {
      this.camera.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.camera.zoom * d));
      this.camera.updateProjectionMatrix();
    }
  }

  _dollyOut(d) {
    if (this.camera.isPerspectiveCamera) this.scale *= d;
    else if (this.camera.isOrthographicCamera) {
      this.camera.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.camera.zoom / d));
      this.camera.updateProjectionMatrix();
    }
  }

  _panLeft(distance) {
    const v = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    v.multiplyScalar(-distance);
    this.panOffset.add(v);
  }

  _panUp(distance) {
    if (this.screenSpacePanning) {
      const v = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
      v.multiplyScalar(distance);
      this.panOffset.add(v);
    } else {
      const v = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
      v.crossVectors(this.camera.up, v);
      v.multiplyScalar(distance);
      this.panOffset.add(v);
    }
  }

  _pan(deltaX, deltaY) {
    const h = this.domElement.clientHeight || 1;
    if (this.camera.isPerspectiveCamera) {
      const off = this.camera.position.clone().sub(this.target);
      let td = off.length() * Math.tan((this.camera.fov / 2) * Math.PI / 180);
      this._panLeft((2 * deltaX * td) / h);
      this._panUp((2 * deltaY * td) / h);
    } else if (this.camera.isOrthographicCamera) {
      const w = this.domElement.clientWidth || 1;
      this._panLeft((deltaX * (this.camera.right - this.camera.left)) / this.camera.zoom / w);
      this._panUp((deltaY * (this.camera.top - this.camera.bottom)) / this.camera.zoom / h);
    }
  }

  /** 每帧调用：应用 accumulate 的 rotateDelta / panOffset / scale / rotateZDelta（含阻尼）。 */
  update() {
    if (!this.enabled) return;
    const offset = this.camera.position.clone().sub(this.target);

    // 旋转（ROTATE 状态累积）：同 ThreeDControls.cpp update() 的环绕数学
    const moveDirection = new THREE.Vector3(this.rotateDelta.x, this.rotateDelta.y, 0);
    const angle = moveDirection.length();
    if (angle) {
      const eyeDirection = offset.clone().normalize();
      const objectUpDirection = this.camera.up.clone().normalize();
      const objectSidewaysDirection = new THREE.Vector3().crossVectors(objectUpDirection, eyeDirection).normalize();
      const mu = objectUpDirection.multiplyScalar(-this.rotateDelta.y);
      const ms = objectSidewaysDirection.multiplyScalar(this.rotateDelta.x);
      moveDirection.copy(mu.add(ms));
      const axis = new THREE.Vector3().crossVectors(moveDirection, offset).normalize();
      const q = new THREE.Quaternion().setFromAxisAngle(axis, angle);
      offset.applyQuaternion(q);
      this.camera.up.applyQuaternion(q);
    }

    this.target.add(this.panOffset);
    offset.multiplyScalar(this.scale);
    this.camera.position.copy(this.target).add(offset);
    this.camera.lookAt(this.target);

    // 绕 Z 滚转（ROTATEZ 状态累积）
    if (this.rotateZDelta.x) {
      const axis = new THREE.Vector3();
      this.camera.getWorldDirection(axis);
      const qz = new THREE.Quaternion().setFromAxisAngle(axis, -this.rotateZDelta.x);
      this.camera.up.applyQuaternion(qz);
    }

    if (this.enableDamping && !this.dragging) {
      this.rotateDelta.multiplyScalar(1 - this.dampingFactor);
      this.rotateZDelta.multiplyScalar(1 - this.dampingFactor);
    } else {
      this.rotateDelta.set(0, 0);
      this.rotateZDelta.set(0, 0);
    }
    this.panOffset.set(0, 0, 0);
    this.scale = 1;
  }
}
