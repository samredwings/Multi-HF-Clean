// Real-shaped /config documents for the Gradio generations this app must support.
// These replace the hand-written config the previous build tested against, which
// is why its suite passed while the app was unusable on most of the Hub.

export const gradio3Config = {
  version: "3.50.2",
  mode: "blocks",
  title: "Legacy SDXL Space",
  components: [
    { id: 1, type: "textbox", props: { label: "Prompt", lines: 2, value: "" } },
    { id: 2, type: "slider", props: { label: "Steps", minimum: 1, maximum: 50, value: 25 } },
    { id: 3, type: "image", props: { label: "Result" } },
    { id: 4, type: "markdown", props: { value: "hello" } },
  ],
  dependencies: [
    { api_name: "predict", inputs: [1, 2, 4], outputs: [3], backend_fn: true },
    { api_name: "load_example_1", inputs: [], outputs: [1], backend_fn: true },
  ],
};

export const gradio4Config = {
  version: "4.44.1",
  api_prefix: "/gradio_api",
  title: "Gradio 4 Video Space",
  components: [
    { id: 5, type: "textbox", props: { label: "Prompt", lines: 3 } },
    { id: 6, type: "dropdown", props: { label: "Model", choices: [["Fast", "fast"], "quality"], value: "fast" } },
    { id: 7, type: "video", props: { label: "Clip" } },
  ],
  dependencies: [
    { id: 0, api_name: "generate", inputs: [5, 6], outputs: [7], backend_fn: true },
    { id: 1, api_name: "_internal_helper", inputs: [5], outputs: [5], backend_fn: true },
  ],
};

export const gradio5Config = {
  version: "5.12.0",
  api_prefix: "/gradio_api",
  title: "Gradio 5 Batch Space",
  components: [
    { id: 9, type: "textbox", props: { label: "Instruction", lines: 4 } },
    { id: 10, type: "checkbox", props: { label: "Upscale", value: true } },
    { id: 11, type: "gallery", props: { label: "Frames" } },
    { id: 12, type: "state", props: { value: { seed: 1 } } },
  ],
  dependencies: [
    { id: 3, api_name: "infer", inputs: [9, 10, 12], outputs: [11], backend_fn: true },
    { id: 4, api_name: "process", inputs: [9], outputs: [11], api_visibility: "private" },
  ],
};

export const gradio5NoPrefixConfig = {
  version: "5.4.0",
  title: "Prefixless Space",
  components: [
    { id: 1, type: "textbox", props: { label: "Prompt", lines: 2 } },
    { id: 2, type: "image", props: { label: "Out" } },
  ],
  dependencies: [{ id: 0, api_name: "generate", inputs: [1], outputs: [2], backend_fn: true }],
};

export const unknownVersionConfig = {
  title: "Unversioned Space",
  components: [
    { id: 1, type: "textbox", props: { label: "Prompt", lines: 2 } },
    { id: 2, type: "audio", props: { label: "Speech" } },
  ],
  dependencies: [{ id: 0, api_name: "speak", inputs: [1], outputs: [2], backend_fn: true }],
};

/** A Space record as the probe would store it, for queue tests. */
export function spaceRecord(overrides = {}) {
  return {
    id: "owner/space",
    kind: "space",
    ref: "owner/space",
    host: "https://owner-space.hf.space",
    title: "Test Space",
    note: "",
    task: "image",
    accountId: "",
    private: false,
    sendToken: false,
    endpoints: [{
      apiName: "generate",
      fnIndex: 0,
      fields: [{ key: "c1", label: "Prompt", type: "textarea", hidden: false, choices: [], defaultValue: "" }],
      outputs: [{ key: "o2", label: "Out", type: "image" }],
    }],
    activeApi: "generate",
    protocol: {
      base: "/gradio_api",
      mode: "queue",
      version: "5.12.0",
      verified: true,
      source: "declared",
      uploadPath: "/gradio_api/upload",
      callPath: "/gradio_api/call",
      configPath: "/config",
      streamEvents: { complete: ["complete", "process_completed"], progress: ["generating"] },
    },
    needsProbe: false,
    probedAt: 1,
    fetchedAt: 1,
    ...overrides,
  };
}

