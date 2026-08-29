Pod::Spec.new do |s|
  s.name           = 'FalconDeckPerf'
  s.version        = '1.0.0'
  s.summary        = 'Own-process CPU and memory sampling for the diagnostics screen'
  s.description    = 'Samples the app process CPU usage and physical memory footprint via public Mach task APIs.'
  s.author         = 'FalconDeck'
  s.homepage       = 'https://falcondeck.com'
  s.license        = { :type => 'MIT' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = '**/*.{h,m,swift}'
end
