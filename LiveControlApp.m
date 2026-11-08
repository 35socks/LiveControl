#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import <CoreImage/CoreImage.h>
#import <ifaddrs.h>
#import <arpa/inet.h>
#import <net/if.h>
#import <string.h>

@interface LiveControlApp : NSObject <NSApplicationDelegate>
@property(nonatomic, strong) NSStatusItem *statusItem;
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) WKWebView *webView;
@property(nonatomic, strong) NSTask *serverTask;
@property(nonatomic, strong) NSTimer *startupTimer;
@property(nonatomic, strong) NSURL *dataDirectory;
@property(nonatomic, strong) NSURL *portFile;
@property(nonatomic, strong) NSPopover *popover;
@property(nonatomic, strong) NSView *statusDot;
@property(nonatomic, strong) NSTextField *statusLabel;
@property(nonatomic, strong) NSImageView *qrImageView;
@property(nonatomic, strong) NSTextField *qrHintLabel;
@property(nonatomic, strong) NSTextField *networkURLLabel;
@property(nonatomic, strong) NSTextField *localURLLabel;
@property(nonatomic, strong) NSButton *networkCopyButton;
@property(nonatomic, strong) NSButton *localCopyButton;
@property(nonatomic, copy) NSString *statusText;
@property(nonatomic) BOOL serverFailed;
@property(nonatomic) NSInteger port;
@end

@implementation LiveControlApp

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    self.statusText = @"Starting LiveControl…";
    NSImage *appIcon = [self bundledImageNamed:@"icon"];
    if (appIcon) NSApp.applicationIconImage = appIcon;
    [self configureWindow];
    [self configureMenuBar];
    [self startServer];
}

- (void)applicationWillTerminate:(NSNotification *)notification {
    [self.startupTimer invalidate];
    if (self.serverTask.running) [self.serverTask terminate];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender { return NO; }

// Clicking the Dock icon brings the window back if it was closed or hidden.
- (BOOL)applicationShouldHandleReopen:(NSApplication *)sender hasVisibleWindows:(BOOL)flag {
    if (!flag) [self showWindow];
    return YES;
}

- (NSImage *)bundledImageNamed:(NSString *)name {
    NSString *path = [NSBundle.mainBundle pathForResource:name ofType:@"png"];
    return path ? [[NSImage alloc] initWithContentsOfFile:path] : nil;
}

- (void)configureWindow {
    NSRect frame = NSMakeRect(0, 0, 560, 760);
    self.window = [[NSWindow alloc] initWithContentRect:frame
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable
        backing:NSBackingStoreBuffered defer:NO];
    self.window.title = @"LiveControl";
    self.window.minSize = NSMakeSize(340, 420);
    self.window.releasedWhenClosed = NO;
    [self.window setFrameAutosaveName:@"LiveControlMainWindow"]; // remember the size/position you pick
    self.window.backgroundColor = [NSColor colorWithRed:0.04 green:0.04 blue:0.04 alpha:1];
    self.webView = [[WKWebView alloc] initWithFrame:self.window.contentView.bounds];
    self.webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [self.window.contentView addSubview:self.webView];
    if (![self.window setFrameUsingName:@"LiveControlMainWindow"]) [self.window center];
    [self.window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
}

- (void)configureMenuBar {
    self.statusItem = [[NSStatusBar systemStatusBar] statusItemWithLength:NSVariableStatusItemLength];
    NSImage *glyph = [self bundledImageNamed:@"menubar-icon"];
    if (glyph) {
        // Source art is @2x; template lets macOS tint it for light/dark menu bars.
        glyph.size = NSMakeSize(glyph.size.width / 2.0, glyph.size.height / 2.0);
    } else {
        glyph = [NSImage imageWithSystemSymbolName:@"waveform.path" accessibilityDescription:@"LiveControl"];
    }
    glyph.template = YES;
    self.statusItem.button.image = glyph;
    self.statusItem.button.imagePosition = NSImageOnly;
    self.statusItem.button.title = @"";
    self.statusItem.button.toolTip = @"LiveControl";
    self.statusItem.button.target = self;
    self.statusItem.button.action = @selector(togglePopover:);
    [self configurePopover];
}

/* ── Menu bar popover: status, QR code, URLs, settings gear ───────────────── */

static NSTextField *LCLabel(NSString *text, CGFloat size, NSFontWeight weight, NSColor *color, NSTextAlignment align) {
    NSTextField *label = [NSTextField labelWithString:text];
    label.font = [NSFont systemFontOfSize:size weight:weight];
    label.textColor = color;
    label.alignment = align;
    return label;
}

- (NSTextField *)urlLabel {
    NSTextField *label = [NSTextField labelWithString:@""];
    label.font = [NSFont monospacedSystemFontOfSize:12 weight:NSFontWeightRegular];
    label.allowsEditingTextAttributes = YES; // lets the URL act as a clickable link
    label.selectable = YES;
    label.lineBreakMode = NSLineBreakByTruncatingMiddle;
    return label;
}

- (NSButton *)copyButtonWithAction:(SEL)action {
    NSButton *button = [NSButton buttonWithImage:[NSImage imageWithSystemSymbolName:@"doc.on.doc" accessibilityDescription:@"Copy"] target:self action:action];
    button.bordered = NO;
    button.toolTip = @"Copy";
    return button;
}

- (void)configurePopover {
    const CGFloat width = 300;
    NSView *content = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, width, 420)];

    // Header: status dot + "LiveControl is Running!" + gear
    self.statusDot = [[NSView alloc] initWithFrame:NSMakeRect(18, 386, 10, 10)];
    self.statusDot.wantsLayer = YES;
    self.statusDot.layer.cornerRadius = 5;
    [content addSubview:self.statusDot];

    self.statusLabel = LCLabel(@"", 14, NSFontWeightSemibold, NSColor.labelColor, NSTextAlignmentLeft);
    self.statusLabel.frame = NSMakeRect(36, 382, 214, 18);
    self.statusLabel.lineBreakMode = NSLineBreakByTruncatingTail;
    [content addSubview:self.statusLabel];

    NSButton *gear = [NSButton buttonWithImage:[NSImage imageWithSystemSymbolName:@"gearshape" accessibilityDescription:@"Settings"] target:self action:@selector(showSettingsMenu:)];
    gear.frame = NSMakeRect(width - 44, 377, 28, 28);
    gear.bordered = NO;
    gear.toolTip = @"Settings";
    [content addSubview:gear];

    // QR code on a white card (needs light background to scan, even in Dark Mode)
    NSView *card = [[NSView alloc] initWithFrame:NSMakeRect((width - 200) / 2, 168, 200, 200)];
    card.wantsLayer = YES;
    card.layer.backgroundColor = NSColor.whiteColor.CGColor;
    card.layer.cornerRadius = 10;
    [content addSubview:card];
    self.qrImageView = [[NSImageView alloc] initWithFrame:NSMakeRect(12, 12, 176, 176)];
    self.qrImageView.imageScaling = NSImageScaleProportionallyUpOrDown;
    [card addSubview:self.qrImageView];

    self.qrHintLabel = [NSTextField wrappingLabelWithString:@""];
    self.qrHintLabel.font = [NSFont systemFontOfSize:11.5];
    self.qrHintLabel.textColor = NSColor.secondaryLabelColor;
    self.qrHintLabel.alignment = NSTextAlignmentCenter;
    self.qrHintLabel.frame = NSMakeRect(20, 130, width - 40, 32);
    [content addSubview:self.qrHintLabel];

    // URL rows
    NSTextField *networkTitle = LCLabel(@"PHONE / TABLET", 10, NSFontWeightSemibold, NSColor.tertiaryLabelColor, NSTextAlignmentLeft);
    networkTitle.frame = NSMakeRect(20, 106, width - 40, 14);
    [content addSubview:networkTitle];
    self.networkURLLabel = [self urlLabel];
    self.networkURLLabel.frame = NSMakeRect(20, 84, width - 66, 18);
    [content addSubview:self.networkURLLabel];
    self.networkCopyButton = [self copyButtonWithAction:@selector(copyNetworkAddress:)];
    self.networkCopyButton.frame = NSMakeRect(width - 42, 81, 24, 24);
    [content addSubview:self.networkCopyButton];

    NSTextField *localTitle = LCLabel(@"THIS MAC", 10, NSFontWeightSemibold, NSColor.tertiaryLabelColor, NSTextAlignmentLeft);
    localTitle.frame = NSMakeRect(20, 56, width - 40, 14);
    [content addSubview:localTitle];
    self.localURLLabel = [self urlLabel];
    self.localURLLabel.frame = NSMakeRect(20, 34, width - 66, 18);
    [content addSubview:self.localURLLabel];
    self.localCopyButton = [self copyButtonWithAction:@selector(copyLocalAddress:)];
    self.localCopyButton.frame = NSMakeRect(width - 42, 31, 24, 24);
    [content addSubview:self.localCopyButton];

    NSViewController *controller = [[NSViewController alloc] init];
    controller.view = content;
    self.popover = [[NSPopover alloc] init];
    self.popover.contentViewController = controller;
    self.popover.contentSize = NSMakeSize(width, 420);
    self.popover.behavior = NSPopoverBehaviorTransient;
    self.popover.animates = YES;
    [self refreshPopover];
}

static NSAttributedString *LCLink(NSString *url) {
    return [[NSAttributedString alloc] initWithString:url attributes:@{
        NSLinkAttributeName: [NSURL URLWithString:url],
        NSFontAttributeName: [NSFont monospacedSystemFontOfSize:12 weight:NSFontWeightRegular],
        NSForegroundColorAttributeName: NSColor.linkColor
    }];
}

// Re-reads state (server status, Wi-Fi address) into the popover. Called on open and on state changes.
- (void)refreshPopover {
    if (!self.popover) return;
    BOOL running = self.port > 0 && !self.serverFailed;
    NSColor *dot = self.serverFailed ? NSColor.systemRedColor : (running ? NSColor.systemGreenColor : NSColor.systemOrangeColor);
    self.statusDot.layer.backgroundColor = dot.CGColor;
    self.statusLabel.stringValue = self.statusText ?: @"";

    NSString *network = [self networkURLString];
    NSString *local = self.port > 0 ? self.localURL.absoluteString : nil;
    if (network) {
        self.qrImageView.image = [self qrImageForString:network pointSize:176];
        self.qrHintLabel.stringValue = @"Scan with your phone or tablet camera. Both devices need to be on the same Wi-Fi.";
        self.networkURLLabel.attributedStringValue = LCLink(network);
    } else {
        self.qrImageView.image = nil;
        self.qrHintLabel.stringValue = running ? @"No network address found. Connect this Mac to Wi-Fi." : @"";
        self.networkURLLabel.stringValue = @"—";
    }
    if (local) self.localURLLabel.attributedStringValue = LCLink(local);
    else self.localURLLabel.stringValue = @"—";
    self.networkCopyButton.enabled = network != nil;
    self.localCopyButton.enabled = local != nil;
}

- (void)togglePopover:(id)sender {
    if (self.popover.shown) { [self.popover close]; return; }
    [self refreshPopover]; // Wi-Fi address can change between openings
    [self.popover showRelativeToRect:self.statusItem.button.bounds ofView:self.statusItem.button preferredEdge:NSRectEdgeMinY];
    [self.popover.contentViewController.view.window makeKeyWindow]; // so outside clicks dismiss it
}

- (void)showSettingsMenu:(NSButton *)sender {
    BOOL windowShown = self.window.isVisible && !self.window.isMiniaturized;
    NSMenu *menu = [[NSMenu alloc] initWithTitle:@"Settings"];
    NSMenuItem *toggle = [[NSMenuItem alloc] initWithTitle:windowShown ? @"Hide LiveControl Window" : @"Show LiveControl Window" action:@selector(toggleWindow) keyEquivalent:@""];
    toggle.image = [NSImage imageWithSystemSymbolName:windowShown ? @"eye.slash" : @"eye" accessibilityDescription:nil];
    NSMenuItem *quit = [[NSMenuItem alloc] initWithTitle:@"Quit LiveControl" action:@selector(quit) keyEquivalent:@""];
    quit.image = [NSImage imageWithSystemSymbolName:@"power" accessibilityDescription:nil];
    toggle.target = self; quit.target = self;
    [menu addItem:toggle];
    [menu addItem:[NSMenuItem separatorItem]];
    [menu addItem:quit];
    [menu popUpMenuPositioningItem:nil atLocation:NSMakePoint(0, sender.bounds.size.height + 4) inView:sender];
}

- (void)flashCopied:(NSButton *)button {
    button.image = [NSImage imageWithSystemSymbolName:@"checkmark" accessibilityDescription:@"Copied"];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.2 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        button.image = [NSImage imageWithSystemSymbolName:@"doc.on.doc" accessibilityDescription:@"Copy"];
    });
}

- (void)copyString:(NSString *)string {
    [NSPasteboard.generalPasteboard clearContents];
    [NSPasteboard.generalPasteboard setString:string forType:NSPasteboardTypeString];
}

- (void)copyNetworkAddress:(id)sender {
    NSString *url = [self networkURLString];
    if (!url) return;
    [self copyString:url];
    [self flashCopied:self.networkCopyButton];
}

- (void)copyLocalAddress:(id)sender {
    if (self.port <= 0) return;
    [self copyString:self.localURL.absoluteString];
    [self flashCopied:self.localCopyButton];
}

- (void)startServer {
    NSURL *resources = NSBundle.mainBundle.resourceURL;
    NSURL *project = [resources URLByAppendingPathComponent:@"LiveControl" isDirectory:YES];
    NSURL *node = [resources URLByAppendingPathComponent:@"node"];
    NSURL *support = [[NSFileManager.defaultManager URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask] firstObject];
    self.dataDirectory = [support URLByAppendingPathComponent:@"LiveControl" isDirectory:YES];
    self.portFile = [self.dataDirectory URLByAppendingPathComponent:@"server.port"];
    NSError *error = nil;
    [NSFileManager.defaultManager createDirectoryAtURL:self.dataDirectory withIntermediateDirectories:YES attributes:nil error:&error];
    if (error) { [self setStatus:@"Could not start LiveControl" failed:YES]; return; }
    [NSFileManager.defaultManager removeItemAtURL:self.portFile error:nil];
    self.serverTask = [[NSTask alloc] init];
    self.serverTask.executableURL = node;
    self.serverTask.arguments = @[[[project URLByAppendingPathComponent:@"server.js"] path]];
    self.serverTask.currentDirectoryURL = self.dataDirectory;
    NSMutableDictionary *environment = [NSProcessInfo.processInfo.environment mutableCopy];
    environment[@"PORT"] = @"0";
    environment[@"PORT_FILE"] = self.portFile.path;
    environment[@"LIVECONTROL_DATA_DIR"] = self.dataDirectory.path;
    self.serverTask.environment = environment;
    NSFileHandle *nullOutput = [NSFileHandle fileHandleForWritingAtPath:@"/dev/null"];
    self.serverTask.standardOutput = nullOutput;
    self.serverTask.standardError = nullOutput;
    __weak typeof(self) weakSelf = self;
    self.serverTask.terminationHandler = ^(NSTask *task) {
        dispatch_async(dispatch_get_main_queue(), ^{ weakSelf.startupTimer = nil; [weakSelf setStatus:task.terminationStatus == 0 ? @"LiveControl is stopped" : @"LiveControl failed to start" failed:YES]; });
    };
    if (![self.serverTask launchAndReturnError:&error]) { [self setStatus:@"Could not start LiveControl" failed:YES]; return; }
    self.startupTimer = [NSTimer scheduledTimerWithTimeInterval:0.4 target:self selector:@selector(checkServerReady) userInfo:nil repeats:YES];
}

- (void)checkServerReady {
    if (!self.serverTask.running) { [self setStatus:@"LiveControl failed to start" failed:YES]; [self.startupTimer invalidate]; self.startupTimer = nil; return; }
    NSString *value = [NSString stringWithContentsOfURL:self.portFile encoding:NSUTF8StringEncoding error:nil];
    NSInteger parsedPort = value.integerValue;
    if (parsedPort <= 0) return;
    self.port = parsedPort;
    [self.startupTimer invalidate]; self.startupTimer = nil;
    [self setStatus:@"LiveControl is Running!" failed:NO];
    [self.webView loadRequest:[NSURLRequest requestWithURL:self.localURL]];
}

- (void)setStatus:(NSString *)text failed:(BOOL)failed {
    self.statusText = text;
    self.serverFailed = failed;
    [self refreshPopover];
}

- (NSURL *)localURL { return [NSURL URLWithString:[NSString stringWithFormat:@"http://127.0.0.1:%ld", (long)self.port]]; }
- (void)showWindow {
    if (self.window.isMiniaturized) [self.window deminiaturize:nil];
    [self.window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
}
- (void)hideWindow { [self.window orderOut:nil]; }
- (void)toggleWindow {
    [self.popover close];
    if (self.window.isVisible && !self.window.isMiniaturized) [self hideWindow]; else [self showWindow];
}

- (NSString *)localIPv4Address {
    struct ifaddrs *interfaces = NULL;
    if (getifaddrs(&interfaces) != 0) return nil;
    NSString *fallback = nil, *address = nil;
    for (struct ifaddrs *item = interfaces; item != NULL; item = item->ifa_next) {
        if (!item->ifa_addr || item->ifa_addr->sa_family != AF_INET || (item->ifa_flags & IFF_LOOPBACK)) continue;
        char buffer[INET_ADDRSTRLEN];
        if (!inet_ntop(AF_INET, &((struct sockaddr_in *)item->ifa_addr)->sin_addr, buffer, sizeof(buffer))) continue;
        NSString *candidate = [NSString stringWithUTF8String:buffer];
        if (strcmp(item->ifa_name, "en0") == 0) { address = candidate; break; }
        if (!fallback) fallback = candidate;
    }
    freeifaddrs(interfaces);
    return address ?: fallback;
}

/* ── QR code for quick device connection ─────────────────────────────────── */

- (NSString *)networkURLString {
    NSString *host = [self localIPv4Address];
    if (!host || self.port <= 0) return nil;
    return [NSString stringWithFormat:@"http://%@:%ld", host, (long)self.port];
}

// Renders `string` as a crisp QR code using Core Image (no extra libraries).
- (NSImage *)qrImageForString:(NSString *)string pointSize:(CGFloat)pointSize {
    CIFilter *filter = [CIFilter filterWithName:@"CIQRCodeGenerator"];
    [filter setValue:[string dataUsingEncoding:NSUTF8StringEncoding] forKey:@"inputMessage"];
    [filter setValue:@"M" forKey:@"inputCorrectionLevel"];
    CIImage *output = filter.outputImage;
    if (!output) return nil;
    CGFloat pixels = pointSize * 2.0; // render at 2x so it stays sharp on Retina
    CGFloat scale = MAX(1.0, floor(pixels / output.extent.size.width));
    CIImage *scaled = [[output imageBySamplingNearest] imageByApplyingTransform:CGAffineTransformMakeScale(scale, scale)];
    CIContext *context = [CIContext contextWithOptions:nil];
    CGImageRef cgImage = [context createCGImage:scaled fromRect:scaled.extent];
    if (!cgImage) return nil;
    NSImage *image = [[NSImage alloc] initWithCGImage:cgImage size:NSMakeSize(scaled.extent.size.width / 2.0, scaled.extent.size.height / 2.0)];
    CGImageRelease(cgImage);
    return image;
}

- (void)quit { [NSApp terminate:nil]; }
@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSApplication *application = NSApplication.sharedApplication;
        LiveControlApp *delegate = [[LiveControlApp alloc] init];
        application.delegate = delegate;
        [application run];
    }
    return 0;
}
