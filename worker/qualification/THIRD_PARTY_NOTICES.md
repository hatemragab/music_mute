# Numerical algorithm attribution

The Kim-only MDX/STFT implementation in `musicmute_worker/separation.py` follows
audio-separator v0.47.0 numerical behavior, from these pinned upstream sources:

- https://github.com/nomadkaraoke/python-audio-separator/blob/v0.47.0/audio_separator/separator/architectures/mdx_separator.py
- https://github.com/nomadkaraoke/python-audio-separator/blob/v0.47.0/audio_separator/separator/uvr_lib_v5/stft.py
- https://github.com/nomadkaraoke/python-audio-separator/blob/v0.47.0/audio_separator/separator/uvr_lib_v5/spec_utils.py

This attribution covers implementation code only. Kim Vocal 2 model redistribution
and native runtime/FFmpeg notices require their own review; no binaries ship here.

MIT License

Copyright (c) 2023 karaokenerds

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
