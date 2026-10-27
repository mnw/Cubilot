// Launch ack time (4.1): the default is 15 s. The other launch-queue tests lower it through the ackMs option.

import { expect, test } from "bun:test";
import { DEFAULT_LAUNCH_ACK_MS } from "../../hub/kinds/stage";

test("the default launch ack time is 15 s", () => {
  expect(DEFAULT_LAUNCH_ACK_MS).toBe(15_000);
});
