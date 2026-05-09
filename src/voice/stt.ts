// Speech-to-text via the browser's SpeechRecognition. Auto-sends when a
// dictation session ends with content, so the mic flow is hands-free.

import { addSystem } from "../chat/messages";
import { send } from "../chat/chat";

const SpeechRec: any =
  (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

const micBtn = document.getElementById("mic") as HTMLButtonElement;
const input = document.getElementById("input") as HTMLTextAreaElement;

let recognition: any = null;
let isRecording = false;

if (SpeechRec) {
  recognition = new SpeechRec();
  recognition.lang = "en-US";
  recognition.interimResults = true;
  recognition.continuous = false;

  let finalTranscript = "";

  recognition.onstart = () => {
    isRecording = true;
    finalTranscript = "";
    micBtn.classList.add("recording");
  };

  recognition.onresult = (event: any) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; ++i) {
      const result = event.results[i];
      if (result.isFinal) finalTranscript += result[0].transcript;
      else interim += result[0].transcript;
    }
    input.value = (finalTranscript + interim).trim();
    input.dispatchEvent(new Event("input"));
  };

  recognition.onend = () => {
    isRecording = false;
    micBtn.classList.remove("recording");
    if (input.value.trim() && finalTranscript.trim()) {
      send();
    }
  };

  recognition.onerror = (e: any) => {
    isRecording = false;
    micBtn.classList.remove("recording");
    if (e.error !== "aborted" && e.error !== "no-speech") {
      addSystem(`Mic error: ${e.error}`);
    }
  };
} else {
  micBtn.disabled = true;
  micBtn.title = "Speech recognition not supported in this webview";
}

micBtn.addEventListener("click", () => {
  if (!recognition) return;
  if (isRecording) recognition.stop();
  else recognition.start();
});
