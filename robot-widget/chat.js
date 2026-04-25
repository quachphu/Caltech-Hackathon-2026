const { ipcRenderer } = window.require('electron');
const fs = window.require('fs');
const path = window.require('path');
const input = document.getElementById('chat-input');
const btn = document.getElementById('send-btn');
const messages = document.getElementById('messages');

// The responses array is obsolete - we now use Gemini.

let currentAudio = new window.Audio();
let audioUnlocked = false;

async function speak(text) {
  try {
    const audioPath = await ipcRenderer.invoke('generate-speech', text);
    if (audioPath) {
      const fullPath = path.resolve(__dirname, audioPath);
      const buffer = fs.readFileSync(fullPath);
      const base64 = buffer.toString('base64');
      const ext = audioPath.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav';
      currentAudio.src = `data:${ext};base64,` + base64;
      currentAudio.playbackRate = 1.0;
      currentAudio.play().catch(e => console.error("Audio block reasoning:", e.name, e.message));
    }
  } catch (e) {
    console.error("Failed to fetch Piper TTS audio", e);
  }
}

function addMessage(text, sender) {
  const div = document.createElement('div');
  div.className = `msg ${sender}`;
  div.textContent = text;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight; // Auto-scroll to latest
}

async function handleSend() {
  if (!audioUnlocked) {
    currentAudio.play().catch(() => { });
    currentAudio.pause();
    audioUnlocked = true;
  }

  const text = input.value.trim();
  if (!text) return;

  // 1. Add User Message
  addMessage(text, 'user');
  input.value = '';

  // 2. Add Bot Response after simulated loading
  const loadingDiv = document.createElement('div');
  loadingDiv.className = `msg bot`;
  loadingDiv.textContent = "Processing...";
  messages.appendChild(loadingDiv);
  messages.scrollTop = messages.scrollHeight;

  try {
    const response = await ipcRenderer.invoke('ask-grok', text);
    loadingDiv.textContent = response;
    speak(response);
  } catch (e) {
    loadingDiv.textContent = "Error connecting to AI Mainframe.";
  }
}

btn.addEventListener('click', handleSend);
input.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') handleSend();
});

// Force the browser to load voices early
window.speechSynthesis.getVoices();
input.focus();
