// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AnswerInput, PasswordInput } from "../src/components/secret-inputs.js";

/**
 * These two controls are the reason a password can be typed correctly the first time, so their
 * behaviour is worth pinning down rather than eyeballing: `type` toggling on a focused input is
 * exactly the kind of thing that silently stops working.
 */

afterEach(cleanup);

/** The components are controlled, so a host with state is needed to type into them. */
function Host({ kind }: { kind: "password" | "answer" }) {
  const [value, setValue] = useState("");
  return (
    <>
      {kind === "password" ? (
        <PasswordInput value={value} onChange={setValue} id="secret" />
      ) : (
        <AnswerInput value={value} onChange={setValue} id="secret" />
      )}
      <button type="button">elsewhere</button>
    </>
  );
}

const field = () => document.getElementById("secret") as HTMLInputElement;

describe("PasswordInput", () => {
  it("starts masked and reveals on demand", async () => {
    const user = userEvent.setup();
    render(<Host kind="password" />);

    expect(field().type).toBe("password");

    await user.click(screen.getByRole("button", { name: "Show password" }));
    expect(field().type).toBe("text");

    await user.click(screen.getByRole("button", { name: "Hide password" }));
    expect(field().type).toBe("password");
  });

  it("keeps the revealed password visible after focus moves away", async () => {
    // The point of a manual toggle: the password stays readable while the operator looks at
    // their password manager. Reveal-on-focus would hide it the moment they clicked away.
    const user = userEvent.setup();
    render(<Host kind="password" />);

    await user.click(screen.getByRole("button", { name: "Show password" }));
    await user.click(screen.getByRole("button", { name: "elsewhere" }));

    expect(field().type).toBe("text");
  });

  it("preserves every character of a password full of URL-significant symbols", async () => {
    const user = userEvent.setup();
    render(<Host kind="password" />);

    const gnarly = "%Q4Z2j7kp@0#B^&@e28$B^@7RjnZAVMHp!ucJ";
    await user.click(field());
    await user.keyboard(gnarly.replace(/[{[]/g, "$&$&")); // userEvent treats { and [ as syntax

    expect(field().value).toBe(gnarly);
  });
});

describe("AnswerInput", () => {
  it("reveals while focused and masks once focus leaves", async () => {
    const user = userEvent.setup();
    render(<Host kind="answer" />);

    expect(field().type).toBe("password");

    await user.click(field());
    expect(field().type).toBe("text");

    await user.click(screen.getByRole("button", { name: "elsewhere" }));
    expect(field().type).toBe("password");
  });

  it("keeps focus and accepts typing across the type switch", async () => {
    // Changing `type` on a focused input is the risky part: if the browser drops focus the field
    // masks itself mid-word and the rest of the answer goes somewhere else.
    const user = userEvent.setup();
    render(<Host kind="answer" />);

    await user.click(field());
    await user.keyboard("Ada Lovelace");

    expect(document.activeElement).toBe(field());
    expect(field().type).toBe("text");
    expect(field().value).toBe("Ada Lovelace");
  });
});
