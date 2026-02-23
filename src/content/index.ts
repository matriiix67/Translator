import { setSitePreference, toSiteKey } from "@shared/storage";
import type {
  RuntimeRequestMessage,
  RuntimeResponseMessage
} from "@shared/types";
import { PageTranslator } from "@content/translator";

const siteKey = toSiteKey(window.location.href);
const translator = new PageTranslator((_status) => {
  // 预留给 popup 主动拉取，避免高频广播消息造成噪音。
});

void translator.initialize();

chrome.runtime.onMessage.addListener(
  (
    message: RuntimeRequestMessage,
    _sender,
    sendResponse: (response: RuntimeResponseMessage) => void
  ) => {
    if (!message || typeof message !== "object") {
      return;
    }

    if (message.type === "page:get-status") {
      sendResponse({
        ok: true,
        status: translator.getStatus()
      });
      return;
    }

    if (message.type === "page:toggle") {
      void (async () => {
        await setSitePreference(siteKey, message.payload.enabled);
        await translator.setEnabled(message.payload.enabled);
        sendResponse({
          ok: true,
          status: translator.getStatus()
        });
      })();
      return true;
    }
  }
);

window.addEventListener("beforeunload", () => {
  translator.dispose();
});
