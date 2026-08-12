import { FaceLandmarker, FilesetResolver, DrawingUtils } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

const videoElement = document.getElementById('webcam');
const sharpVideoElement = document.getElementById('webcam-sharp');
const canvasElement = document.getElementById('output');
const canvasCtx = canvasElement.getContext('2d');
const pontElement = document.querySelector('.pont');

// 블렌드셰이프 점수(0~1) 기준 — 값이 높을수록 눈을 세게 감은 상태.
const BLINK_THRESHOLD = 0.4;
const OPEN_OPACITY = '1';
const CLOSED_OPACITY = '0.1';

// FaceLandmarker 478포인트 기준 홍채 중심/눈 양끝 인덱스.
const LEFT_IRIS_CENTER = 468;
const RIGHT_IRIS_CENTER = 473;
const LEFT_EYE_OUTER = 33;
const LEFT_EYE_INNER = 133;
const RIGHT_EYE_INNER = 362;
const RIGHT_EYE_OUTER = 263;
const EYE_REVEAL_RADIUS_MULTIPLIER = 0.65;

let faceLandmarker;
let drawingUtils;
let lastVideoTime = -1;

// 단어별로 span을 씌워서 마우스를 올린 단어만 폰트를 바꿀 수 있게 한다.
function wrapWordsInSpans(el) {
    const tokens = el.textContent.split(/(\s+)/);
    el.innerHTML = '';
    for (const token of tokens) {
        if (token === '' || /^\s+$/.test(token)) {
            el.appendChild(document.createTextNode(token));
        } else {
            const span = document.createElement('span');
            span.className = 'word';
            span.textContent = token;
            el.appendChild(span);
        }
    }
}

// 클릭한 단어를 기준으로 가까운 단어부터 순서대로 클릭한 단어로 바꾼다.
const WORD_SPREAD_STEP_MS = 40;

function spreadWordFromClick(clickedSpan) {
    const words = Array.from(pontElement.querySelectorAll('.word'));
    const clickedIndex = words.indexOf(clickedSpan);
    const clickedText = clickedSpan.textContent;

    words.forEach((word, i) => {
        if (i === clickedIndex) return;
        const distance = Math.abs(i - clickedIndex);
        setTimeout(() => {
            word.textContent = clickedText;
        }, distance * WORD_SPREAD_STEP_MS);
    });
}

if (pontElement) {
    wrapWordsInSpans(pontElement);
    pontElement.addEventListener('click', (e) => {
        const clickedSpan = e.target.closest('.word');
        if (clickedSpan) spreadWordFromClick(clickedSpan);
    });
}

// 눈(홍채) 위치를 화면 좌표로 변환해 #webcam-sharp의 마스크 위치/반경을 갱신한다.
// #webcam-sharp 자체가 CSS에서 scaleX(-1)로 미러링되므로, 여기서는 반전 전(원본) 좌표계로만 계산한다.
function updateEyeReveal(landmarks) {
    if (!sharpVideoElement) return;

    const vw = videoElement.videoWidth;
    const vh = videoElement.videoHeight;
    if (!landmarks || !vw || !vh) {
        sharpVideoElement.style.setProperty('--eye-r', '0px');
        return;
    }

    const dw = window.innerWidth;
    const dh = window.innerHeight;
    const scale = Math.max(dw / vw, dh / vh);
    const offsetX = (dw - vw * scale) / 2;
    const offsetY = (dh - vh * scale) / 2;

    const toScreen = (pt) => ({
        x: pt.x * vw * scale + offsetX,
        y: pt.y * vh * scale + offsetY
    });

    const leftEye = toScreen(landmarks[LEFT_IRIS_CENTER]);
    const rightEye = toScreen(landmarks[RIGHT_IRIS_CENTER]);

    const eyeWidthPx = (a, b) => Math.hypot(
        (landmarks[a].x - landmarks[b].x) * vw * scale,
        (landmarks[a].y - landmarks[b].y) * vh * scale
    );
    const radius = Math.max(
        eyeWidthPx(LEFT_EYE_OUTER, LEFT_EYE_INNER),
        eyeWidthPx(RIGHT_EYE_OUTER, RIGHT_EYE_INNER)
    ) * EYE_REVEAL_RADIUS_MULTIPLIER;

    sharpVideoElement.style.setProperty('--lx', `${leftEye.x}px`);
    sharpVideoElement.style.setProperty('--ly', `${leftEye.y}px`);
    sharpVideoElement.style.setProperty('--rx', `${rightEye.x}px`);
    sharpVideoElement.style.setProperty('--ry', `${rightEye.y}px`);
    sharpVideoElement.style.setProperty('--eye-r', `${radius}px`);
}

function onResults(results) {
    const w = canvasElement.width;
    const h = canvasElement.height;

    canvasCtx.save();
    canvasCtx.clearRect(0, 0, w, h);

    // 눈 추적 (윤곽 + 홍채) — 투명 배경이라 촬영 영상 위에 그대로 겹쳐 보인다.
    if (results.faceLandmarks && results.faceLandmarks.length > 0) {
        for (const landmarks of results.faceLandmarks) {
            drawingUtils.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_LEFT_EYE, { color: '#00000000', lineWidth: 0});
            drawingUtils.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE, { color: '#00000000', lineWidth: 0});
            drawingUtils.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_LEFT_IRIS, { color: '#00000000', lineWidth: 0});
            drawingUtils.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_RIGHT_IRIS, { color: '#00000000', lineWidth: 0 });
        }
        updateEyeReveal(results.faceLandmarks[0]);
    } else {
        updateEyeReveal(null);
    }

    if (pontElement && results.faceBlendshapes && results.faceBlendshapes.length > 0) {
        const categories = results.faceBlendshapes[0].categories;
        const blinkLeft = categories.find((c) => c.categoryName === 'eyeBlinkLeft')?.score ?? 0;
        const blinkRight = categories.find((c) => c.categoryName === 'eyeBlinkRight')?.score ?? 0;
        const blink = Math.max(blinkLeft, blinkRight);
        pontElement.style.opacity = blink > BLINK_THRESHOLD ? CLOSED_OPACITY : OPEN_OPACITY;
    }

    canvasCtx.restore();
}

function renderLoop() {
    if (videoElement.currentTime !== lastVideoTime) {
        lastVideoTime = videoElement.currentTime;
        const results = faceLandmarker.detectForVideo(videoElement, performance.now());
        onResults(results);
    }
    requestAnimationFrame(renderLoop);
}

async function init() {
    const filesetResolver = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
    );
    faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
        baseOptions: {
            modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
            delegate: "GPU"
        },
        outputFaceBlendshapes: true,
        runningMode: "VIDEO",
        numFaces: 1
    });
    drawingUtils = new DrawingUtils(canvasCtx);

    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
    videoElement.srcObject = stream;
    if (sharpVideoElement) sharpVideoElement.srcObject = stream;
    videoElement.addEventListener('loadeddata', () => {
        canvasElement.width = videoElement.videoWidth;
        canvasElement.height = videoElement.videoHeight;
        requestAnimationFrame(renderLoop);
    });
}

init();
