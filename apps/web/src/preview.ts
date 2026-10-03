/**
 * Worker-preview bootstrap: the one module preview.html adds ahead of the
 * stock entry tag. The runtime's optional source stage owns the pre-Cordis
 * chooser; the unchanged Host connector then owns the Worker handshake.
 * Everything after those calls is the served startup chain verbatim.
 */
import DshWorker from '../../../docs/drafts/browser-native-dsh-poc/browser-native-worker.ts?worker'
import browserNativeProfileOverlay from '../../../docs/drafts/browser-native-dsh-poc/browser-native-profile-overlay.tar.gz?url'
import {
  chooseWorkerHostSource, connectWorkerHost, IMAGE_FILE_NAME,
} from '@deepseek-ai/dsh-experimental-webworker-runtime/client'

const image = `preview/${IMAGE_FILE_NAME}`
const source = await chooseWorkerHostSource({ image })
const browserNative = new URLSearchParams(window.location.search).get('browser-native') === '1'
await connectWorkerHost(new DshWorker({ name: 'dsh-host' }), {
  image,
  overlays: browserNative
    ? [...source.overlays, new URL(browserNativeProfileOverlay, document.baseURI)]
    : source.overlays,
})
