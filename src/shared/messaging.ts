import { TRANSLATION_PORT_NAME } from "@shared/constants";
import type {
  BatchTranslationPayload,
  ResegmentPayload,
  RuntimeRequestMessage,
  RuntimeResponseMessage,
  TranslationPortIncomingMessage,
  TranslationPortOutgoingMessage,
  TranslationRequestPayload,
  TranslationSource
} from "@shared/types";

export function createRequestId(prefix = "req"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createTranslationPort(source: TranslationSource): chrome.runtime.Port {
  return chrome.runtime.connect({
    name: `${TRANSLATION_PORT_NAME}:${source}`
  });
}

export function postStartTranslation(
  port: chrome.runtime.Port,
  payload: TranslationRequestPayload
): void {
  const message: TranslationPortIncomingMessage = {
    type: "translate:start",
    payload
  };
  port.postMessage(message);
}

export function postBatchTranslation(
  port: chrome.runtime.Port,
  payload: BatchTranslationPayload
): void {
  const message: TranslationPortIncomingMessage = {
    type: "translate:batch",
    payload
  };
  port.postMessage(message);
}

export function postResegment(
  port: chrome.runtime.Port,
  payload: ResegmentPayload
): void {
  const message: TranslationPortIncomingMessage = {
    type: "translate:resegment",
    payload
  };
  port.postMessage(message);
}

export function onPortMessage(
  port: chrome.runtime.Port,
  handler: (message: TranslationPortOutgoingMessage) => void
): () => void {
  const listener = (message: unknown) => {
    if (!message || typeof message !== "object") {
      return;
    }
    handler(message as TranslationPortOutgoingMessage);
  };
  port.onMessage.addListener(listener);
  return () => {
    port.onMessage.removeListener(listener);
  };
}

export function sendRuntimeMessage(
  message: RuntimeRequestMessage
): Promise<RuntimeResponseMessage> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response: RuntimeResponseMessage) => {
      resolve(
        response ?? {
          ok: false,
          error: "扩展消息未返回响应。"
        }
      );
    });
  });
}
