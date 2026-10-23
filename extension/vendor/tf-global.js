// Puts TensorFlow.js where its WebAssembly backend (tf-backend-wasm.min.js, a plain script) looks for it:
// a global called tf. A copy, because the backend adds its own entry (tf.wasm) and a module's namespace
// can't take one.
import * as tf from './tf.fesm.min.js';

globalThis.tf = { ...tf };
