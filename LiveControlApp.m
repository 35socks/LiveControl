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
@property(nonatomic, strong) NSMenuItem *statusMenuItem;
@property(nonatomic, strong) NSMenuItem *networkMenuItem;
@property(nonatomic, strong) NSWindow *qrWindow;
@property(nonatomic, strong) NSImageView *qrImageView;
@property(nonatomic, strong) NSTextField *qrURLLabel;
@property(nonatomic) NSInteger port;
@end

@implementation LiveControlApp

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    [self configureWindow];
    [self configureMenuBar];
    [self startServer];
}

- (void)applicationWillTerminate:(NSNotification *)notification {
    [self.startupTimer invalidate];
    if (self.serverTask.running) [self.serverTask terminate];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender { return NO; }

- (void)configureWindow {
    NSRect frame = NSMakeRect(0, 0, 1120, 760);
    self.window = [[NSWindow alloc] initWithContentRect:frame
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable
        backing:NSBackingStoreBuffered defer:NO];
    self.window.title = @"LiveControl";
    self.window.minSize = NSMakeSize(760, 560);
    self.window.backgroundColor = [NSColor colorWithRed:0.04 green:0.04 blue:0.04 alpha:1];
    self.webView = [[WKWebView alloc] initWithFrame:self.window.contentView.bounds];
    self.webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [self.window.contentView addSubview:self.webView];
    [self.window center];
    [self.window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
}

- (void)configureMenuBar {
    self.statusItem = [[NSStatusBar systemStatusBar] statusItemWithLength:NSVariableStatusItemLength];
    self.statusItem.button.image = [NSImage imageWithSystemSymbolName:@"waveform.path" accessibilityDescription:@"LiveControl"];
    self.statusItem.button.image.template = YES;
    self.statusItem.button.title = @" LiveControl";
    NSMenu *menu = [[NSMenu alloc] initWithTitle:@"LiveControl"];
    [menu addItem:[[NSMenuItem alloc] initWithTitle:@"Show LiveControl" action:@selector(showWindow) keyEquivalent:@""]];
    self.statusMenuItem = [[NSMenuItem alloc] initWithTitle:@"Starting LiveControl…" action:nil keyEquivalent:@""];
    self.statusMenuItem.enabled = NO;
    [menu addItem:self.statusMenuItem];
    [menu addItem:[NSMenuItem separatorItem]];
    [menu addItem:[[NSMenuItem alloc] initWithTitle:@"Open in Browser" action:@selector(openInBrowser) keyEquivalent:@"b"]];
    self.networkMenuItem = [[NSMenuItem alloc] initWithTitle:@"Copy phone / tablet address" action:@selector(copyNetworkAddress) keyEquivalent:@""];
    [menu addItem:self.networkMenuItem];
    [menu addItem:[[NSMenuItem alloc] initWithTitle:@"Show QR Code for Phone / Tablet…" action:@selector(showQRCode) keyEquivalent:@"r"]];
    [menu addItem:[NSMenuItem separatorItem]];
    [menu addItem:[[NSMenuItem alloc] initWithTitle:@"Quit LiveControl" action:@selector(quit) keyEquivalent:@"q"]];
    for (NSMenuItem *item in menu.itemArray) item.target = self;
    self.statusItem.menu = menu;
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
    if (error) { self.statusMenuItem.title = @"Could not start LiveControl"; return; }
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
        dispatch_async(dispatch_get_main_queue(), ^{ weakSelf.startupTimer = nil; weakSelf.statusMenuItem.title = task.terminationStatus == 0 ? @"LiveControl is stopped" : @"LiveControl failed to start"; });
    };
    if (![self.serverTask launchAndReturnError:&error]) { self.statusMenuItem.title = @"Could not start LiveControl"; return; }
    self.startupTimer = [NSTimer scheduledTimerWithTimeInterval:0.4 target:self selector:@selector(checkServerReady) userInfo:nil repeats:YES];
}

- (void)checkServerReady {
    if (!self.serverTask.running) { self.statusMenuItem.title = @"LiveControl failed to start"; [self.startupTimer invalidate]; self.startupTimer = nil; return; }
    NSString *value = [NSString stringWithContentsOfURL:self.portFile encoding:NSUTF8StringEncoding error:nil];
    NSInteger parsedPort = value.integerValue;
    if (parsedPort <= 0) return;
    self.port = parsedPort;
    [self.startupTimer invalidate]; self.startupTimer = nil;
    self.statusMenuItem.title = @"LiveControl is running";
    NSString *host = [self localIPv4Address] ?: @"localhost";
    self.networkMenuItem.title = [NSString stringWithFormat:@"Copy phone / tablet address (%@:%ld)", host, (long)self.port];
    [self.webView loadRequest:[NSURLRequest requestWithURL:self.localURL]];
}

- (NSURL *)localURL { return [NSURL URLWithString:[NSString stringWithFormat:@"http://127.0.0.1:%ld", (long)self.port]]; }
- (void)showWindow { [self.window makeKeyAndOrderFront:nil]; [NSApp activateIgnoringOtherApps:YES]; }
- (void)openInBrowser { if (self.port > 0) [NSWorkspace.sharedWorkspace openURL:self.localURL]; }

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

- (void)copyNetworkAddress {
    if (self.port <= 0) return;
    NSString *host = [self localIPv4Address] ?: @"localhost";
    NSString *url = [NSString stringWithFormat:@"http://%@:%ld", host, (long)self.port];
    [NSPasteboard.generalPasteboard clearContents];
    [NSPasteboard.generalPasteboard setString:url forType:NSPasteboardTypeString];
    self.statusMenuItem.title = @"Phone / tablet address copied";
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

- (void)configureQRWindow {
    self.qrWindow = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 340, 430)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable
        backing:NSBackingStoreBuffered defer:NO];
    self.qrWindow.title = @"Connect a Phone or Tablet";
    self.qrWindow.releasedWhenClosed = NO;
    NSView *content = self.qrWindow.contentView;

    NSTextField *intro = [NSTextField wrappingLabelWithString:@"Scan with your phone or tablet camera. Both devices need to be on the same Wi-Fi network."];
    intro.frame = NSMakeRect(24, 372, 292, 40);
    intro.alignment = NSTextAlignmentCenter;
    intro.font = [NSFont systemFontOfSize:12];
    intro.textColor = NSColor.secondaryLabelColor;
    [content addSubview:intro];

    // QR codes need a light background and quiet zone to scan reliably, even in Dark Mode.
    NSView *frame = [[NSView alloc] initWithFrame:NSMakeRect(40, 108, 260, 260)];
    frame.wantsLayer = YES;
    frame.layer.backgroundColor = NSColor.whiteColor.CGColor;
    frame.layer.cornerRadius = 10;
    [content addSubview:frame];

    self.qrImageView = [[NSImageView alloc] initWithFrame:NSMakeRect(16, 16, 228, 228)];
    self.qrImageView.imageScaling = NSImageScaleProportionallyUpOrDown;
    [frame addSubview:self.qrImageView];

    self.qrURLLabel = [NSTextField wrappingLabelWithString:@""];
    self.qrURLLabel.frame = NSMakeRect(20, 62, 300, 36);
    self.qrURLLabel.alignment = NSTextAlignmentCenter;
    self.qrURLLabel.selectable = YES;
    self.qrURLLabel.font = [NSFont monospacedSystemFontOfSize:12 weight:NSFontWeightRegular];
    [content addSubview:self.qrURLLabel];

    NSButton *copy = [NSButton buttonWithTitle:@"Copy Address" target:self action:@selector(copyNetworkAddress)];
    copy.frame = NSMakeRect(40, 20, 125, 28);
    [content addSubview:copy];
    NSButton *done = [NSButton buttonWithTitle:@"Done" target:self.qrWindow action:@selector(performClose:)];
    done.frame = NSMakeRect(175, 20, 125, 28);
    done.keyEquivalent = @"\r";
    [content addSubview:done];
}

- (void)showQRCode {
    if (self.port <= 0) return;
    if (!self.qrWindow) [self configureQRWindow];
    // Rebuild each time: the Mac's Wi-Fi address can change between openings.
    NSString *url = [self networkURLString];
    if (url) {
        self.qrImageView.image = [self qrImageForString:url pointSize:228];
        self.qrURLLabel.stringValue = url;
    } else {
        self.qrImageView.image = nil;
        self.qrURLLabel.stringValue = @"No network address found. Connect this Mac to Wi-Fi.";
    }
    [self.qrWindow center];
    [self.qrWindow makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
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
