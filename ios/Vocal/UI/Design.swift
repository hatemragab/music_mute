import SwiftUI

enum VocalStyle {
  // Keep the legacy name while sharing Android's current accent across existing views.
  static let teal = Color(red: 1, green: 0.506, blue: 0.29)
  static let mint = teal
  static func background(_ scheme: ColorScheme) -> Color {
    scheme == .dark
      ? Color(red: 0.063, green: 0.067, blue: 0.082)
      : Color(red: 0.97, green: 0.965, blue: 0.94)
  }
  static func card(_ scheme: ColorScheme) -> Color {
    scheme == .dark ? Color(red: 0.098, green: 0.106, blue: 0.129) : .white
  }
}

struct Waveform: View {
  var color: Color = VocalStyle.teal
  var body: some View {
    GeometryReader { geometry in
      let bars: [(height: CGFloat, opacity: Double, width: CGFloat)] = [
        (0.23, 0.24, 1),
        (0.42, 0.38, 1),
        (0.63, 0.56, 1),
        (1, 1, 1.7),
        (0.63, 0.56, 1),
        (0.42, 0.38, 1),
        (0.23, 0.24, 1),
      ]
      let barWidth = max(2, min(geometry.size.width / 18, 9))
      HStack(alignment: .center, spacing: min(5, geometry.size.width / 28)) {
        ForEach(Array(bars.enumerated()), id: \.offset) { _, bar in
          Capsule().fill(color.opacity(bar.opacity)).frame(
            width: barWidth * bar.width,
            height: geometry.size.height * bar.height)
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
      .foregroundStyle(.black).background(
        VocalStyle.teal.opacity(
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
