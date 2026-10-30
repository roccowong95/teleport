// Only the packaged local main frame may call privileged handlers.
exports.isTrustedSender = (event, window, expectedURL) => !!window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame?.url === expectedURL;
