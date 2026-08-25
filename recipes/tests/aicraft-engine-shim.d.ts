// Minimal stand-in for `aicraft-engine`, so the bridge can be typechecked
// against the REAL rig without installing the sibling package. Only the
// rig's import list needs to resolve; the values are deliberately `any`.
declare module 'aicraft-engine' {
  export type BreathConfig = any;
  export type GaitConfig = any;
  export type JumpInputs = any;
  export type JumpState = any;
  export type LocomotionState = any;
  export type LocomotionPose = any;
  export type SpringConfig = any;
  export type VerletNode = any;
  export type Palette = any;
  export const breathe: any;
  export const advanceSpringChain: any;
  export const advanceLocomotion: any;
  export const advanceLocomotionByDisplacement: any;
  export const advanceJump: any;
  export const createJumpState: any;
  export const evaluateLocomotion: any;
  export const evaluateJump: any;
  export const blendAirborneTuck: any;
  export const blendLocomotionToStance: any;
  export const solveLimb: any;
  export const DEFAULT_BREATH: any;
  export const DEFAULT_GAIT: any;
  export const DEFAULT_JUMP: any;
  export const DEFAULT_SPRING: any;
  export const DEFAULT_TUCK: any;
  export const DEFAULT_OUTLINE_COLOR: any;
  export const lerp: any;
  export const mulberry32: any;
  export const nextFloat: any;
  export const nextInt: any;
  export const generatePalette: any;
}
