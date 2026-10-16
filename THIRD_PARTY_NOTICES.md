# Third-party notices

Nook is licensed under Apache-2.0. The following adapted components retain their original license.

## agent-deck

Source: https://github.com/asheshgoplani/agent-deck

Inspected revision: `8d0f1fe1`. `internal/logging/ringbuffer.go` adapts its circular buffer; `internal/gitwork/git.go` adapts its argument-array worktree creation approach. Related tests cover buffer wraparound and preservation of the dirty source checkout.

MIT License

Copyright (c) 2025 Ashesh Goplani

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.


## Other references

`agents-deck` revision `561c5e5` informed product behavior only. No source or artwork was copied because its local checkout had no project-level license. `loop-engineering` revision `ab47bfa` informed future workflow boundaries; no runtime code was copied.

All Nook character SVGs and the application icon are original code-authored assets. Go, Rust, and npm dependencies retain their respective licenses in their distributions and lockfiles.
