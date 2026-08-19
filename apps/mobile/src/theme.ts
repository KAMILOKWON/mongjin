import { Platform, StyleSheet } from 'react-native';

export const colors = {
  canvas: '#F1EEE8',
  panel: '#FBFAF7',
  surface: '#FFFFFF',
  ink: '#202A33',
  inkSoft: '#647481',
  blue: '#315F89',
  blueStrong: '#284F73',
  line: '#D8D4CC',
  wood: '#D7C5A8',
  woodEdge: '#B5A285',
  ghost: '#739FC7',
  capture: '#FF6B63',
  blackTray: '#303A45',
  whiteTray: '#F1EEE6',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 28,
};

export const typography = StyleSheet.create({
  display: { fontFamily: Platform.select({ ios: 'Georgia', default: undefined }), fontSize: 34, fontWeight: '700' },
  title: { fontSize: 17, fontWeight: '700' },
  body: { fontSize: 14, fontWeight: '500' },
  caption: { fontSize: 12, fontWeight: '500' },
});

export const shadow = Platform.select({
  ios: { shadowColor: colors.ink, shadowOpacity: 0.12, shadowRadius: 10, shadowOffset: { width: 0, height: 5 } },
  android: { elevation: 4 },
  default: {},
});
