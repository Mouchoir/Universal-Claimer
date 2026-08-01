"use client";

import { useState } from "react";

/**
 * The two secret-entry controls used by the sign-in, setup and reset forms.
 *
 * Both exist because a plain `type="password"` is the wrong default for a self-hosted portal
 * used from a home machine: it makes a long generated password impossible to verify while
 * typing, which is exactly when a typo is unrecoverable.
 */

interface BaseProps {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  placeholder?: string;
  required?: boolean;
  minLength?: number;
  autoFocus?: boolean;
  autoComplete?: string;
}

/**
 * Password field with an explicit show/hide toggle. Deliberately a manual toggle rather than
 * reveal-on-focus: a password stays on screen while the operator checks it against a password
 * manager, which reveal-on-focus would hide the moment they click away.
 */
export function PasswordInput({
  value,
  onChange,
  id,
  placeholder,
  required,
  minLength,
  autoFocus,
  autoComplete = "current-password",
}: BaseProps) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div className="uc-secret">
      <input
        id={id}
        type={revealed ? "text" : "password"}
        value={value}
        placeholder={placeholder}
        required={required}
        minLength={minLength}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="uc-quiet"
        onClick={() => setRevealed((r) => !r)}
        aria-pressed={revealed}
        // The control is icon-free text, so the label has to carry the state for a screen reader.
        aria-label={revealed ? "Hide password" : "Show password"}
        title={revealed ? "Hide password" : "Show password"}
      >
        {revealed ? "Hide" : "Show"}
      </button>
    </div>
  );
}

/**
 * Security-answer field: legible while it has focus, masked as soon as it does not.
 *
 * A recovery answer is a secret, but it is also short prose that is easy to mistype, and there
 * are three of them to fill in one after another. Revealing on focus keeps each one checkable as
 * it is typed without leaving all three readable over the operator's shoulder afterwards.
 */
export function AnswerInput({
  value,
  onChange,
  id,
  placeholder,
  required,
  autoComplete = "off",
}: BaseProps) {
  const [focused, setFocused] = useState(false);
  return (
    <input
      id={id}
      type={focused ? "text" : "password"}
      value={value}
      placeholder={placeholder}
      required={required}
      autoComplete={autoComplete}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
