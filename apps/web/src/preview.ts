/**
 * Worker-preview bootstrap: the one module preview.html adds ahead of the
 * stock entry tag. The runtime's optional source stage owns the pre-Cordis
 * chooser; the unchanged Host connector then owns the Worker handshake.
 * Everything after those calls is the served startup chain verbatim.
 */
import DshWorker from '../../../docs/drafts/browser-native-dsh-poc/browser-native-worker.ts?worker'
import browserNativeProfileOverlay from '../../../docs/drafts/browser-native-dsh-poc/browser-native-profile-overlay.tar.gz?url'
import { connectBrowserNativePageControl } from './browser-native-page-control.ts'
import {
  chooseWorkerHostSource, connectWorkerHost, IMAGE_FILE_NAME,
} from '@deepseek-ai/dsh-experimental-webworker-runtime/client'

const browserNative = new URLSearchParams(window.location.search).get('browser-native') === '1'
const pageLifecycle = { unloading: false }
let worker: Worker | undefined
if (browserNative) {
  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return
    pageLifecycle.unloading = true
    worker?.terminate()
  })
}
const image = `preview/${IMAGE_FILE_NAME}`
try {
  const source = await chooseWorkerHostSource({ image })
  if (!browserNative || !pageLifecycle.unloading) {
    worker = new DshWorker({ name: 'dsh-host' })
    if (browserNative) connectBrowserNativePageControl(worker)
    await connectWorkerHost(worker, {
      image,
      overlays: browserNative
        ? [...source.overlays, new URL(browserNativeProfileOverlay, document.baseURI)]
        : source.overlays,
    })
  }
} catch (error) {
  worker?.terminate()
  const message = error instanceof Error ? error.message : String(error)
  if (!browserNative || !pageLifecycle.unloading || !message.startsWith('web-preview tunnel: boot payload failed')) throw error
}
