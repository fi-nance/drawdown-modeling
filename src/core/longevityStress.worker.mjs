import { runLongevityStress } from './longevityStress.mjs';
self.addEventListener('message', ({ data }) => {
  try {
    const results = runLongevityStress({ ...data, onProgress: progress => self.postMessage({ type: 'progress', progress }) });
    self.postMessage({ type: 'result', results });
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message });
  }
});
