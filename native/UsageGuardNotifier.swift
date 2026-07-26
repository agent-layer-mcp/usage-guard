import AppKit
import UserNotifications

private struct NotificationArguments {
    let title: String
    let subtitle: String
    let message: String
    let identifier: String
    let sound: Bool

    init?(arguments: [String]) {
        var values: [String: String] = [:]
        var flags = Set<String>()
        var index = 1

        while index < arguments.count {
            let argument = arguments[index]
            if argument == "--sound" {
                flags.insert(argument)
                index += 1
                continue
            }
            guard argument.hasPrefix("--"), index + 1 < arguments.count else {
                return nil
            }
            values[argument] = arguments[index + 1]
            index += 2
        }

        guard
            let title = values["--title"],
            let message = values["--message"]
        else {
            return nil
        }

        self.title = title
        self.subtitle = values["--subtitle"] ?? ""
        self.message = message
        self.identifier = values["--identifier"] ?? UUID().uuidString
        self.sound = flags.contains("--sound")
    }
}

private final class NotifierDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    private let notification: NotificationArguments
    private var finished = false

    init(notification: NotificationArguments) {
        self.notification = notification
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { [weak self] granted, error in
            guard let self else { return }
            if let error {
                self.finish(code: 2, message: "notification authorization failed: \(error.localizedDescription)")
                return
            }
            guard granted else {
                self.finish(code: 3, message: "notification authorization was not granted")
                return
            }
            self.deliver(with: center)
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list, .sound])
    }

    private func deliver(with center: UNUserNotificationCenter) {
        let content = UNMutableNotificationContent()
        content.title = notification.title
        content.subtitle = notification.subtitle
        content.body = notification.message
        if notification.sound {
            content.sound = .default
        }

        let request = UNNotificationRequest(
            identifier: notification.identifier,
            content: content,
            trigger: UNTimeIntervalNotificationTrigger(timeInterval: 1, repeats: false)
        )
        center.add(request) { [weak self] error in
            guard let self else { return }
            if let error {
                self.finish(code: 4, message: "notification delivery failed: \(error.localizedDescription)")
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                self.finish(code: 0)
            }
        }
    }

    private func finish(code: Int32, message: String? = nil) {
        DispatchQueue.main.async {
            guard !self.finished else { return }
            self.finished = true
            if let message {
                FileHandle.standardError.write(Data("\(message)\n".utf8))
            }
            NSApplication.shared.terminate(nil)
            exit(code)
        }
    }
}

guard let notification = NotificationArguments(arguments: CommandLine.arguments) else {
    FileHandle.standardError.write(Data("""
    Usage: UsageGuardNotifier --title TITLE [--subtitle SUBTITLE] --message MESSAGE \
    [--identifier ID] [--sound]

    """.utf8))
    exit(64)
}

let application = NSApplication.shared
private let delegate = NotifierDelegate(notification: notification)
application.setActivationPolicy(.accessory)
application.delegate = delegate
application.run()
