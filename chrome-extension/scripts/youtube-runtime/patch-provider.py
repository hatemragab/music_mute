"""Bound the pinned upstream provider's requests, cache and shared VM state."""
import argparse
import hashlib
from pathlib import Path

SOURCE_SHA256 = '39a8789229da1003dde24c7e3630a429a4fd7567fd3b8f22d2a2a389b6182c6f'


def replace_once(source, original, replacement):
    if source.count(original) != 1:
        raise ValueError('Pinned token provider source does not match')
    return source.replace(original, replacement, 1)


def patch(source):
    if hashlib.sha256(source.encode()).hexdigest() != SOURCE_SHA256:
        raise ValueError('Pinned token provider source does not match')
    source = replace_once(source, '                        proxy: false,',
                          '                        proxy: false,\n                        timeout: 5000,')
    source = replace_once(source, 'const bgFetch = this.getFetch(pxySpec, 3, 5000);',
                          'const bgFetch = this.getFetch(pxySpec, 1, 0);')
    source = replace_once(source, '        this._minterCache.set(cacheSpec.key, tokenMinter);',
                          '        if (!this._minterCache.has(cacheSpec.key) && this._minterCache.size >= 128) {\n'
                          '            this._minterCache.delete(this._minterCache.keys().next().value!);\n'
                          '        }\n        this._minterCache.set(cacheSpec.key, tokenMinter);')
    # YouTube challenge configuration is shared globally by the BotGuard VM.
    # Keep configuration local while fetching, then serialize only VM evaluation
    # and snapshot. Audio transfers and challenge network requests stay parallel.
    source = replace_once(source, 'export class SessionManager {', '''class MintMutex {
    private tail: Promise<void> = Promise.resolve();
    async acquire(): Promise<() => void> {
        let release!: () => void;
        const previous = this.tail;
        this.tail = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        return release;
    }
}

export class SessionManager {''')
    source = replace_once(source, '    private _minterCache: MinterCache = new Map();',
                          '    private _minterCache: MinterCache = new Map();\n'
                          '    private mintMutex = new MintMutex();')
    source = replace_once(source, r'''            const ytcfgMatch = pageHtml.match(/ytcfg\.set\(({.+?})\);/s);
            if (ytcfgMatch) {
                const ytObj = { config_: JSON.parse(ytcfgMatch[1] as string) };
                const g: any = globalThis as any;
                g.yt = ytObj; // BotGuard reads yt.config_.EVENT_ID
                if (g.window) g.window.yt = ytObj;
            } else {''', r'''            const ytcfgMatch = pageHtml.match(/ytcfg\.set\(({.+?})\);/s);
            let musicmuteYtConfig: any;
            if (ytcfgMatch) {
                musicmuteYtConfig = { config_: JSON.parse(ytcfgMatch[1] as string) };
            } else {''')
    source = replace_once(source, '            return bgChallenge as ChallengeData;',
                          '            return { ...bgChallenge, musicmuteYtConfig } as ChallengeData;')
    source = replace_once(source, '                interpreterHash,\n                interpreterJavascript:',
                          '                interpreterHash,\n'
                          '                musicmuteYtConfig: (challenge as any).musicmuteYtConfig,\n'
                          '                interpreterJavascript:')
    source = replace_once(source, '''                interpreterUrl: {
                    privateDoNotAccessOrElseTrustedResourceUrlWrappedValue,
                },
            };''', '''                interpreterUrl: {
                    privateDoNotAccessOrElseTrustedResourceUrlWrappedValue,
                },
            } as IBotguardClientSideBgChallenge;''')
    source = replace_once(source, '''        if (interpreterJavascript) {
            new Function(interpreterJavascript)();''', '''        const release = await this.mintMutex.acquire();
        let webPoSignalOutput: WebPoSignalOutput;
        let botguardResponse: unknown;
        try {
            const config = (descrambledChallenge as any).musicmuteYtConfig;
            const g: any = globalThis as any;
            if (config) {
                g.yt = config;
                if (g.window) g.window.yt = config;
            } else {
                delete g.yt;
                if (g.window) delete g.window.yt;
            }
        if (interpreterJavascript) {
            new Function(interpreterJavascript)();''')
    source = replace_once(source, '''        try {
            const webPoSignalOutput: WebPoSignalOutput = [];
            const botguardResponse = await bgClient.snapshot({
                webPoSignalOutput,
            });
            const integrityTokenResp = await potCtx.fetch(''', '''            webPoSignalOutput = [];
            botguardResponse = await bgClient.snapshot({ webPoSignalOutput });
        } finally {
            release();
        }
        try {
            const integrityTokenResp = await potCtx.fetch(''')
    return source


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    path = parser.parse_args().source
    path.write_text(patch(path.read_text()))


if __name__ == '__main__':
    main()
