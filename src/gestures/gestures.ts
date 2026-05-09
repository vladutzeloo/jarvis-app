// MediaPipe gesture recognition over the front camera. Maps a small set of
// gestures to chat actions (send, mic toggle, clear, stop speech). Models
// are bundled locally under /mediapipe/, no CDN dependency.

import { GestureRecognizer, FilesetResolver } from "@mediapipe/tasks-vision";
import { addSystem } from "../chat/messages";
import { send, getIsGenerating } from "../chat/chat";
import { cancelSpeech } from "../voice/tts";
import { tryRadioGestureCommand, isRadioCameraActive } from "../radio/radio";

const cameraPanel = document.getElementById("camera-panel") as HTMLElement;
const cameraFeed = document.getElementById("camera-feed") as HTMLVideoElement;
const cameraOverlay = document.getElementById("camera-overlay") as HTMLElement;
const cameraToggleBtn = document.getElementById("camera-toggle") as HTMLButtonElement;
const cameraCloseBtn = document.getElementById("camera-close") as HTMLButtonElement;

const input = document.getElementById("input") as HTMLTextAreaElement;
const micBtn = document.getElementById("mic") as HTMLButtonElement;
const clearBtn = document.getElementById("clear") as HTMLButtonElement;

const GESTURE_COOLDOWN_MS = 1500;

let gestureRecognizer: GestureRecognizer | null = null;
let cameraStream: MediaStream | null = null;
let cameraActive = false;
let lastFiredGesture = "";
let lastFiredAt = 0;
let lastVideoTime = -1;

async function initGestureRecognizer() {
  if (gestureRecognizer) return;
  const vision = await FilesetResolver.forVisionTasks("/mediapipe");
  gestureRecognizer = await GestureRecognizer.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: "/mediapipe/gesture_recognizer.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numHands: 1,
  });
}

async function startCamera() {
  try {
    cameraOverlay.textContent = "loading model...";
    cameraPanel.classList.remove("hidden");
    await initGestureRecognizer();
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 320, height: 240 },
      audio: false,
    });
    cameraFeed.srcObject = cameraStream;
    cameraActive = true;
    cameraOverlay.textContent = "ready";
    cameraToggleBtn.classList.add("camera-on");
    requestAnimationFrame(processFrame);
  } catch (e: any) {
    cameraOverlay.textContent = `error: ${e.message}`;
    addSystem(`Camera error: ${e.message}`);
  }
}

function stopCamera() {
  cameraActive = false;
  cameraToggleBtn.classList.remove("camera-on");
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  cameraFeed.srcObject = null;
  cameraPanel.classList.add("hidden");
}

async function processFrame() {
  if (!cameraActive || !gestureRecognizer || !cameraFeed.videoWidth) {
    if (cameraActive) requestAnimationFrame(processFrame);
    return;
  }

  if (cameraFeed.currentTime !== lastVideoTime) {
    lastVideoTime = cameraFeed.currentTime;
    try {
      const result = gestureRecognizer.recognizeForVideo(cameraFeed, performance.now());
      if (result.gestures.length > 0 && result.gestures[0].length > 0) {
        const top = result.gestures[0][0];
        if (top.score > 0.7 && top.categoryName !== "None") {
          cameraOverlay.textContent = `${prettyGesture(top.categoryName)} ${Math.round(top.score * 100)}%`;
          handleGesture(top.categoryName);
        } else {
          cameraOverlay.textContent = "-";
        }
      } else {
        cameraOverlay.textContent = "show your hand";
      }
    } catch {
      // Inference can fail on rare frames; ignore and continue.
    }
  }

  requestAnimationFrame(processFrame);
}

function prettyGesture(name: string): string {
  return ({
    "Open_Palm": "Open Palm",
    "Closed_Fist": "Fist",
    "Pointing_Up": "Point",
    "Thumb_Up": "Thumb Up",
    "Thumb_Down": "Thumb Down",
    "Victory": "Victory",
    "ILoveYou": "I love you",
  } as any)[name] || name;
}

function handleGesture(name: string) {
  const now = performance.now();
  // Same gesture must wait the cooldown before firing again.
  if (name === lastFiredGesture && now - lastFiredAt < GESTURE_COOLDOWN_MS) return;
  lastFiredGesture = name;
  lastFiredAt = now;

  // Radio takes priority when its tab is open or its camera-cmd toggle is on -
  // gives the user a way to DJ from across the room without touching the chat.
  const radioActive = document.querySelector('.view[data-view="radio"]')?.classList.contains("active");
  if (radioActive || isRadioCameraActive()) {
    if (tryRadioGestureCommand(name)) {
      flashCamera(`radio: ${prettyGesture(name)}`);
      return;
    }
  }

  switch (name) {
    case "Open_Palm":
      cancelSpeech();
      flashCamera("stopped speech");
      break;
    case "Thumb_Up":
      if (input.value.trim() && !getIsGenerating()) {
        send();
        flashCamera("sent");
      }
      break;
    case "Victory":
      micBtn.click();
      flashCamera("mic toggled");
      break;
    case "Thumb_Down":
      if (!getIsGenerating()) {
        clearBtn.click();
        flashCamera("conversation cleared");
      }
      break;
  }
}

let flashTimer: number | undefined;
function flashCamera(action: string) {
  cameraOverlay.classList.add("flash");
  cameraOverlay.textContent = `> ${action}`;
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => {
    cameraOverlay.classList.remove("flash");
  }, 800);
}

cameraToggleBtn.addEventListener("click", () => {
  if (cameraActive) stopCamera();
  else startCamera();
});
cameraCloseBtn.addEventListener("click", stopCamera);
