import SwiftUI

private enum LibraryFilter: String, CaseIterable, Identifiable {
  case all, favorites, downloaded, notDownloaded, removed
  var id: String { rawValue }
  var title: LocalizedStringKey { LocalizedStringKey("library_filter_\(rawValue)") }
}

private struct LibraryPreferences: Codable {
  var favorites = Set<String>()
  var hidden = Set<String>()
}

@MainActor final class LibraryPreferencesStore: ObservableObject {
  @Published private(set) var favorites = Set<String>()
  @Published private(set) var hidden = Set<String>()
  private let defaults: UserDefaults
  private var ownerUID = ""

  init(defaults: UserDefaults = .standard) { self.defaults = defaults }

  func bind(_ uid: String) {
    guard uid != ownerUID else { return }
    ownerUID = uid
    guard !uid.isEmpty,
      let data = defaults.data(forKey: storageKey),
      let value = try? JSONDecoder().decode(LibraryPreferences.self, from: data)
    else {
      favorites = []
      hidden = []
      return
    }
    favorites = value.favorites
    hidden = value.hidden
  }

  func toggleFavorite(_ id: String) {
    guard !ownerUID.isEmpty else { return }
    var updated = favorites
    if !updated.insert(id).inserted { updated.remove(id) }
    favorites = updated
    save()
  }

  func toggleHidden(_ id: String) {
    guard !ownerUID.isEmpty else { return }
    var updated = hidden
    if !updated.insert(id).inserted { updated.remove(id) }
    hidden = updated
    save()
  }

  private var storageKey: String { "musicmute.ios.library.\(ownerUID)" }

  private func save() {
    if let data = try? JSONEncoder().encode(
      LibraryPreferences(favorites: favorites, hidden: hidden))
    {
      defaults.set(data, forKey: storageKey)
    }
  }
}

struct LibraryView: View {
  @ObservedObject var history: ProcessingHistoryModel
  @ObservedObject var model: ProcessingModel
  @ObservedObject var artifacts: JobArtifactRepository
  @ObservedObject var preferences: LibraryPreferencesStore
  var onOpenDetails: (Job) -> Void
  @State private var search = ""
  @State private var titleSort = false
  @State private var filter = LibraryFilter.all
  @State private var cachedIDs = Set<String>()

  private var readyJobs: [Job] {
    model.libraryJobs.filter { $0.canDownloadOutput }
  }

  private var shownJobs: [Job] {
    readyJobs.filter { job in
      let matchesSearch =
        search.isEmpty
        || job.preferredName.localizedCaseInsensitiveContains(search)
      let matchesFilter: Bool
      switch filter {
      case .all: matchesFilter = !preferences.hidden.contains(job.id)
      case .favorites:
        matchesFilter =
          preferences.favorites.contains(job.id)
          && !preferences.hidden.contains(job.id)
      case .downloaded:
        matchesFilter = cachedIDs.contains(job.id) && !preferences.hidden.contains(job.id)
      case .notDownloaded:
        matchesFilter = !cachedIDs.contains(job.id) && !preferences.hidden.contains(job.id)
      case .removed: matchesFilter = preferences.hidden.contains(job.id)
      }
      return matchesSearch && matchesFilter
    }.sorted { left, right in
      titleSort
        ? left.preferredName.localizedCaseInsensitiveCompare(right.preferredName)
          == .orderedAscending
        : left.createdAt > right.createdAt
    }
  }

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 16) {
        HStack {
          VStack(alignment: .leading, spacing: 4) {
            Text("library_title").font(.largeTitle.bold())
            Text("library_subtitle").foregroundStyle(.secondary)
          }
          Spacer()
          Button {
            titleSort.toggle()
          } label: {
            Image(systemName: titleSort ? "textformat" : "calendar")
              .frame(width: 44, height: 44)
          }
          .accessibilityLabel(Text(titleSort ? "library_sort_title" : "library_sort_newest"))
        }
        TextField("library_search", text: $search)
          .textFieldStyle(.roundedBorder)
          .textInputAutocapitalization(.never)
          .accessibilityIdentifier("librarySearch")
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 8) {
            ForEach(LibraryFilter.allCases) { value in
              Button(value.title) { filter = value }
                .buttonStyle(.borderedProminent)
                .tint(filter == value ? VocalStyle.teal : Color.secondary.opacity(0.22))
            }
          }
        }
        if history.loading && history.jobs.isEmpty { ProgressView() }
        if !history.loading && shownJobs.isEmpty {
          ContentUnavailableView(
            "library_empty", systemImage: "music.note.list", description: Text("library_empty_body")
          )
          .frame(maxWidth: .infinity).padding(.vertical, 36)
        }
        if let messageKey = history.messageKey {
          Text(LocalizedStringKey(messageKey)).foregroundStyle(.red)
        }
        if let messageKey = model.messageKey {
          Text(LocalizedStringKey(messageKey)).foregroundStyle(.secondary)
        }
        ForEach(shownJobs) { job in
          let progress = artifacts.progress[job.id]
          LibraryRow(
            job: job, favorite: preferences.favorites.contains(job.id),
            downloaded: cachedIDs.contains(job.id), hidden: preferences.hidden.contains(job.id),
            downloading: progress != nil,
            downloadProgress: progress.flatMap { value in
              value.totalBytes.flatMap { total in
                total > 0 ? Double(value.receivedBytes) / Double(total) : nil
              }
            },
            onFavorite: { preferences.toggleFavorite(job.id) },
            onPlay: { model.play(job, queue: shownJobs) },
            onDownload: {
              model.download(job) { _ in Task { await refreshCacheState() } }
            },
            onDetails: { onOpenDetails(job) },
            onHide: { preferences.toggleHidden(job.id) })
        }
        if history.nextCursor != nil {
          Button {
            Task { await history.loadMore() }
          } label: {
            HStack {
              if history.loadingMore { ProgressView() }
              Text("processing_more")
            }
          }
          .buttonStyle(.bordered).disabled(history.loading || history.loadingMore)
          .accessibilityIdentifier("libraryLoadMore")
        }
      }.padding(20).frame(maxWidth: 680).frame(maxWidth: .infinity)
    }
    .navigationBarHidden(true)
    .task { await refreshCacheState() }
    .task(id: readyJobs.map(\.id).joined(separator: ":")) { await refreshCacheState() }
  }

  private func refreshCacheState() async {
    var next = Set<String>()
    for job in readyJobs {
      if await artifacts.isCached(jobId: job.id) { next.insert(job.id) }
    }
    cachedIDs = next
  }
}

private struct LibraryRow: View {
  let job: Job
  let favorite: Bool
  let downloaded: Bool
  let hidden: Bool
  let downloading: Bool
  let downloadProgress: Double?
  let onFavorite: () -> Void
  let onPlay: () -> Void
  let onDownload: () -> Void
  let onDetails: () -> Void
  let onHide: () -> Void

  var body: some View {
    VocalCard {
      HStack(spacing: 14) {
        Image(systemName: "waveform")
          .font(.title2).foregroundStyle(VocalStyle.teal)
          .frame(width: 48, height: 48)
          .background(VocalStyle.teal.opacity(0.13), in: RoundedRectangle(cornerRadius: 14))
        VStack(alignment: .leading, spacing: 4) {
          Text(job.preferredName).font(.headline).lineLimit(2)
          HStack(spacing: 5) {
            Image(systemName: downloaded ? "arrow.down.circle.fill" : "icloud")
            Text(downloaded ? "library_downloaded" : "library_online")
          }.font(.caption).foregroundStyle(.secondary)
        }
        Spacer(minLength: 4)
        Button(action: onFavorite) {
          Image(systemName: favorite ? "star.fill" : "star").frame(width: 44, height: 44)
        }.accessibilityLabel(Text(favorite ? "library_unfavorite" : "library_favorite"))
          .accessibilityIdentifier("libraryFavorite-\(job.id)")
      }
      HStack(spacing: 10) {
        Button(action: onPlay) { Label("play", systemImage: "play.fill") }
          .buttonStyle(.borderedProminent)
          .accessibilityIdentifier("libraryPlay-\(job.id)")
        if !downloaded {
          Button(action: onDownload) {
            Label(
              downloading ? "library_downloading" : "library_download",
              systemImage: "arrow.down.circle")
          }.buttonStyle(.bordered).disabled(downloading)
            .accessibilityIdentifier("libraryDownload-\(job.id)")
        }
        Button("processing_details", action: onDetails).buttonStyle(.bordered)
          .accessibilityIdentifier("libraryDetails-\(job.id)")
        Spacer()
        Button(role: hidden ? nil : .destructive, action: onHide) {
          Image(systemName: hidden ? "arrow.uturn.backward" : "eye.slash")
            .frame(width: 44, height: 44)
        }.accessibilityLabel(Text(hidden ? "library_restore" : "library_hide"))
      }
      if downloading {
        if let downloadProgress {
          ProgressView(value: min(1, max(0, downloadProgress)))
        } else {
          ProgressView()
        }
      }
    }
  }
}
