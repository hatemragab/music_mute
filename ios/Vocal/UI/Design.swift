import SwiftUI

enum VocalStyle {
  static let teal = Color(
    uiColor: UIColor { traits in
      traits.userInterfaceStyle == .dark
        ? UIColor(red: 0.57, green: 0.85, blue: 0.75, alpha: 1)
        : UIColor(red: 0.08, green: 0.51, blue: 0.45, alpha: 1)
    })
  static let mint = Color(red: 0.57, green: 0.85, blue: 0.75)
  static func background(_ scheme: ColorScheme) -> Color {
    scheme == .dark
      ? Color(red: 0.055, green: 0.085, blue: 0.08) : Color(red: 0.97, green: 0.965, blue: 0.94)
  }
  static func card(_ scheme: ColorScheme) -> Color {
    scheme == .dark ? Color(red: 0.10, green: 0.14, blue: 0.13) : .white
  }
}

struct Waveform: View {
  var color: Color = VocalStyle.teal
  var body: some View {
    GeometryReader { geometry in
      HStack(alignment: .center, spacing: min(5, geometry.size.width / 35)) {
        ForEach(
          Array(
            [0.22, 0.44, 0.7, 0.4, 0.95, 0.62, 0.35, 0.8, 0.5, 0.3, 0.65, 0.4, 0.2].enumerated()),
          id: \.offset
        ) { _, value in
          Capsule().fill(color).frame(height: geometry.size.height * value)
        }
      }.frame(maxWidth: .infinity, maxHeight: .infinity)
    }.accessibilityHidden(true)
  }
}

struct VocalCard<Content: View>: View {
  @Environment(\.colorScheme) private var scheme
  @ViewBuilder var content: Content
  var body: some View {
    VStack(alignment: .leading, spacing: 16) { content }
      .frame(maxWidth: .infinity, alignment: .leading).padding(20)
      .background(VocalStyle.card(scheme), in: RoundedRectangle(cornerRadius: 24))
  }
}

struct PrimaryButtonStyle: ButtonStyle {
  @Environment(\.isEnabled) private var enabled
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.font(.headline).frame(maxWidth: .infinity, minHeight: 52)
      .foregroundStyle(.white).background(
        Color(red: 0.08, green: 0.51, blue: 0.45).opacity(
          enabled ? (configuration.isPressed ? 0.75 : 1) : 0.4),
        in: RoundedRectangle(cornerRadius: 16))
  }
}

func audioTime(_ seconds: Double) -> String {
  guard seconds.isFinite, seconds > 0 else { return "0:00" }
  let total = Int(min(seconds, Double(Int32.max)))
  return total >= 3600
    ? String(format: "%d:%02d:%02d", total / 3600, total / 60 % 60, total % 60)
    : String(format: "%d:%02d", total / 60, total % 60)
}
