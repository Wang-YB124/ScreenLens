import argparse
import json
import os
import sys
import time
import wave

import numpy as np
import sherpa_onnx

TAG_RE = __import__('re').compile(r'<\|[^|>]*\|>')


def clean_text(text):
    return TAG_RE.sub('', str(text or '')).strip()


def read_wav(path):
    with wave.open(path, 'rb') as w:
        rate = w.getframerate()
        channels = w.getnchannels()
        width = w.getsampwidth()
        frames = w.readframes(w.getnframes())
    if width == 2:
        samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    elif width == 4:
        samples = np.frombuffer(frames, dtype=np.int32).astype(np.float32) / 2147483648.0
    else:
        raise ValueError(f'unsupported sample width: {width}')
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    if rate != 16000:
        duration = len(samples) / rate
        target = np.arange(0, duration, 1.0 / 16000)
        source = np.arange(len(samples)) / rate
        samples = np.interp(target, source, samples).astype(np.float32)
    return samples.astype(np.float32)


def main():
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stdin.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True)
    parser.add_argument('--tokens', required=True)
    parser.add_argument('--language', default='auto')
    parser.add_argument('--threads', type=int, default=4)
    parser.add_argument('--wav')
    args = parser.parse_args()

    if not os.path.isfile(args.model) or not os.path.isfile(args.tokens):
        print(json.dumps({'ready': False, 'error': 'model or tokens missing'}), flush=True)
        return 1

    language = args.language if args.language in ('auto', 'zh', 'en', 'ja', 'ko', 'yue') else 'auto'
    started = time.time()
    recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=args.model,
        tokens=args.tokens,
        num_threads=max(1, args.threads),
        use_itn=True,
        language=language,
        debug=False,
    )
    load_ms = round((time.time() - started) * 1000)
    warm = np.zeros(16000 // 3, dtype=np.float32)
    stream = recognizer.create_stream()
    stream.accept_waveform(16000, warm)
    recognizer.decode_stream(stream)

    def recognize(path):
        t0 = time.time()
        samples = read_wav(path)
        stream = recognizer.create_stream()
        stream.accept_waveform(16000, samples)
        recognizer.decode_stream(stream)
        result = stream.result
        return {
            'text': clean_text(getattr(result, 'text', '')),
            'lang': clean_text(getattr(result, 'lang', '')) or language,
            'emotion': clean_text(getattr(result, 'emotion', '')),
            'event': clean_text(getattr(result, 'event', '')),
            'ms': round((time.time() - t0) * 1000),
        }

    if args.wav:
        out = recognize(args.wav)
        out['load_ms'] = load_ms
        print(json.dumps(out, ensure_ascii=False), flush=True)
        return 0

    print(json.dumps({'ready': True, 'load_ms': load_ms, 'language': language}, ensure_ascii=False), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as exc:
            print(json.dumps({'error': f'bad request: {exc}'}), flush=True)
            continue
        if req.get('cmd') == 'quit':
            break
        try:
            out = recognize(req.get('wav'))
            out['id'] = req.get('id')
            print(json.dumps(out, ensure_ascii=False), flush=True)
        except Exception as exc:
            print(json.dumps({'id': req.get('id'), 'error': str(exc)}), ensure_ascii=False, flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
