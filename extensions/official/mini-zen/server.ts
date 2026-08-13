import { defineExtension } from "@falcondeck/extension-sdk";

export default defineExtension({
  activate(context) {
    context.log.info("Mini Zen activated");
  },
});
