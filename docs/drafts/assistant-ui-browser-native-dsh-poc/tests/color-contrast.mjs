/**
 * @returns Contrast measurements for the rendered chat text and disabled controls.
 */
export function measureAssistantUiContrast() {
  function rgb(color) {
    const channels = color.match(/[\d.]+/g)?.map(Number)
    if (channels === undefined || channels.length < 3) throw new Error(`unsupported CSS color: ${color}`)
    return channels.slice(0, 3).map(channel => channel / 255)
  }

  function linearize(channel) {
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  }

  function luminance(color) {
    const [red, green, blue] = rgb(color).map(linearize)
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue
  }

  function ratio(foreground, background) {
    const foregroundLuminance = luminance(foreground)
    const backgroundLuminance = luminance(background)
    return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
      / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  }

  const shell = document.querySelector('.poc-shell')
  const shellStyle = getComputedStyle(shell)
  const shellBackground = shellStyle.backgroundColor
  const messageLabels = [...document.querySelectorAll('.message-label')].map((label, index) => ({
    name: `message label ${index + 1}`,
    ratio: ratio(getComputedStyle(label).color, getComputedStyle(label.parentElement).backgroundColor),
  }))
  const messageBodies = [...document.querySelectorAll('.message-body')].map((message, index) => ({
    name: `message body ${index + 1}`,
    ratio: ratio(getComputedStyle(message).color, getComputedStyle(message.parentElement).backgroundColor),
  }))
  const messageParagraphs = [...document.querySelectorAll('.message-body p')].map((paragraph, index) => ({
    name: `message paragraph ${index + 1}`,
    ratio: ratio(getComputedStyle(paragraph).color, getComputedStyle(paragraph.closest('.message-row')).backgroundColor),
  }))
  const heading = document.querySelector('h1')
  const composer = document.querySelector('.composer-root')
  const composerBackground = getComputedStyle(composer).backgroundColor
  const composerNote = document.querySelector('.composer-note')
  const input = document.querySelector('.composer-input')
  const footer = document.querySelector('.poc-footer')
  const disabledButtons = [...document.querySelectorAll('button:disabled')].map((button, index) => ({
    name: `disabled button ${index + 1}`,
    ratio: ratio(getComputedStyle(button).color, getComputedStyle(button).backgroundColor),
  }))

  return {
    pageText: ratio(shellStyle.color, shellBackground),
    heading: ratio(getComputedStyle(heading).color, shellBackground),
    messageLabels,
    messageBodies,
    messageParagraphs,
    composerNote: ratio(getComputedStyle(composerNote).color, composerBackground),
    composerPlaceholder: ratio(getComputedStyle(input, '::placeholder').color, composerBackground),
    footer: ratio(getComputedStyle(footer).color, shellBackground),
    disabledButtons,
  }
}
