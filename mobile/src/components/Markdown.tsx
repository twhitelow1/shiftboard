// A manual page's text (lib/minimark.ts): headings, lists, bold, italic, notes and links. Links to the web
// open in the browser, tel:/sms:/mailto: in the phone's apps, and '#/…' app links in the matching screen.
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { Fragment, type ReactNode } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';

import { routeForLink } from '@/lib/links';
import { parseBlocks, parseInline, type Inline } from '@/lib/minimark';
import { useSession } from '@/lib/session';
import { useColors } from './ui';

export function Markdown({ text, size = 16 }: { text: string; size?: number }) {
  const c = useColors();
  const { has } = useSession();
  const open = (href: string) => {
    if (href.startsWith('#/')) router.push(routeForLink(href, has));
    else if (/^https?:/i.test(href)) WebBrowser.openBrowserAsync(href).catch(() => Linking.openURL(href));
    else Linking.openURL(href).catch(() => {});
  };
  const inline = (tokens: Inline[]): ReactNode => tokens.map((x, i) => {
    if (x.t === 'text') return <Fragment key={i}>{x.v}</Fragment>;
    if (x.t === 'b') return <Text key={i} style={{ fontWeight: '800' }}>{inline(x.c)}</Text>;
    if (x.t === 'i') return <Text key={i} style={{ fontStyle: 'italic' }}>{inline(x.c)}</Text>;
    if (x.t !== 'a') return null;
    return <Text key={i} style={{ color: c.brand, textDecorationLine: 'underline' }} onPress={() => open(x.href)} accessibilityRole="link">{inline(x.c)}</Text>;
  });
  const body = { color: c.text, fontSize: size, lineHeight: Math.round(size * 1.45) };
  return (
    <View style={{ gap: 10 }}>
      {parseBlocks(text).map((b, i) => {
        if (b.type === 'h') {
          const fs = b.level === 1 ? size + 4 : b.level === 2 ? size + 2 : size;
          return <Text key={i} accessibilityRole="header" style={{ color: c.text, fontSize: fs, lineHeight: Math.round(fs * 1.3), fontWeight: '800', marginTop: i ? 6 : 0 }}>{inline(parseInline(b.text))}</Text>;
        }
        if (b.type === 'list') {
          return (
            <View key={i} style={{ gap: 6 }}>
              {b.items.map((it, k) => (
                <View key={k} style={styles.li}>
                  <Text style={[body, styles.mark]}>{b.ordered ? `${(b.start || 1) + k}.` : '•'}</Text>
                  <Text style={[body, { flex: 1 }]}>{inline(parseInline(it))}</Text>
                </View>
              ))}
            </View>
          );
        }
        const lines = b.lines.map((l, k) => <Fragment key={k}>{k > 0 ? '\n' : null}{inline(parseInline(l))}</Fragment>);
        if (b.type === 'note') {
          return <View key={i} style={[styles.note, { backgroundColor: c.warnSoft, borderColor: c.warn }]}><Text style={body}>{lines}</Text></View>;
        }
        return <Text key={i} style={body}>{lines}</Text>;
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  li: { flexDirection: 'row', gap: 8, paddingLeft: 4 },
  mark: { minWidth: 18, textAlign: 'right' },
  note: { borderLeftWidth: 4, borderRadius: 8, padding: 12 },
});
