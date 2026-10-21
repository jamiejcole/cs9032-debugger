// Contract: see docs/CONTRACTS.md. Changes go through docs/proposals/.

export interface SourceLoc {
  /** Absolute path. */
  file: string;
  /** 1-based. */
  line: number;
}

export interface SourceMap {
  /** Location for a flash word address, or undefined if nothing was emitted there. */
  addrToLoc(wordAddr: number): SourceLoc | undefined;
  /** Word addresses of the code emitted for a source line (empty if none). */
  locToAddrs(file: string, line: number): number[];
  /** True if the word holds an instruction, false for .db/.dw data or nothing. */
  isCode(wordAddr: number): boolean;
  /** True if the word came from a macro expansion. */
  isMacro(wordAddr: number): boolean;
}

export interface Symbols {
  /** Label -> flash word address (code labels) or data address (.dseg labels). */
  labels: Map<string, { addr: number; seg: 'cseg' | 'dseg' | 'eseg' }>;
  /**
   * .def aliases. Aliases are scoped by source position because of .undef/re-.def:
   * `defsAt` returns the aliases in force at a location.
   */
  defsAt(loc?: SourceLoc): Map<string, number>;
  /** .equ / .set constants (last value wins for .set). Includes m2560def.inc. */
  equs: Map<string, number>;
  /** I/O register name -> data-space address (I/O-space values already +0x20). */
  io: Map<string, number>;
}

export interface Diagnostic {
  file: string;
  line: number;
  severity: 'error' | 'warning';
  message: string;
}

export interface BuildResult {
  ok: boolean;
  hexPath?: string;
  eepPath?: string;
  objPath?: string;
  diagnostics: Diagnostic[];
  output: string;
}
